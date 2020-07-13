import { TwaGenerator } from "@bubblewrap/core/dist/lib/TwaGenerator";
import { TwaManifest, TwaManifestJson, ShortcutInfo } from "@bubblewrap/core/dist/lib/TwaManifest";
import { findSuitableIcon } from "@bubblewrap/core/dist/lib/util";
import { Config } from "@bubblewrap/core/dist/lib/Config";
import { AndroidSdkTools } from "@bubblewrap/core/dist/lib/androidSdk/AndroidSdkTools";
import { JdkHelper } from "@bubblewrap/core/dist/lib/jdk/JdkHelper";
import { GradleWrapper } from "@bubblewrap/core/dist/lib/GradleWrapper";
import fs from "fs-extra";
import { ApkOptions } from "./apkOptions";
import constants from "../constants";
import { KeyTool, CreateKeyOptions } from "@bubblewrap/core/dist/lib/jdk/KeyTool";
import { WebManifestShortcutJson } from "@bubblewrap/core/dist/lib/types/WebManifest";
import { LocalKeyFileSigningOptions } from "./signingOptions";

/*
 * Wraps Google's bubblewrap to build a signed APK from a PWA.
 * https://github.com/GoogleChromeLabs/bubblewrap/tree/master/packages/core
 */
export class BubbleWrapper { 

    private javaConfig: Config;
    private jdkHelper: JdkHelper;
    private androidSdkTools: AndroidSdkTools;

    /**
     * 
     * @param apkSettings The settings for the APK generation.
     * @param projectDirectory The directory where to generate the project files and signed APK.
     * @param signingKeyInfo Information about the signing key.
     * @param jdkPath The path to the JDK.
     * @param androidToolsPath The path to the Android Build tooks.
     */
    constructor(
        private apkSettings: ApkOptions, 
        private projectDirectory: string, 
        private signingKeyInfo: LocalKeyFileSigningOptions | null) {

        this.javaConfig = new Config(constants.JDK_PATH, constants.ANDROID_TOOLS_PATH);
        this.jdkHelper = new JdkHelper(process, this.javaConfig);
        this.androidSdkTools = new AndroidSdkTools(process, this.javaConfig, this.jdkHelper);
    }

    /**
     * Generates a signed APK from the PWA.
     */
    async generateApk(): Promise<string> {  
        // Create an optimized APK.      
        await this.generateTwaProject();
        const apkPath = await this.buildApk();
        const optimizedApkPath = await this.optimizeApk(apkPath);

        // Do we have signing info? If so, sign it.
        if (this.signingKeyInfo) {
            const signedApkPath = await this.signApk(optimizedApkPath, this.signingKeyInfo);
            return signedApkPath;
        } else {
            return optimizedApkPath;
        }
    }

    private async generateTwaProject(): Promise<TwaManifest> {
        const twaGenerator = new TwaGenerator();
        const twaManifest = this.createTwaManifest(this.apkSettings);
        await twaGenerator.createTwaProject(this.projectDirectory, twaManifest);
        return twaManifest;
    }

    private async createSigningKey(signingInfo: LocalKeyFileSigningOptions) {
        const keyTool = new KeyTool(this.jdkHelper);
        const overwriteExisting = true;
        const keyOptions: CreateKeyOptions = {
            path: signingInfo.keyFilePath,
            password: signingInfo.storePassword,
            keypassword: signingInfo.keyPassword,
            alias: signingInfo.alias,
            fullName: signingInfo.fullName,
            organization: signingInfo.organization,
            organizationalUnit: signingInfo.organizationalUnit,
            country: signingInfo.countryCode
        };
        
        await keyTool.createSigningKey(keyOptions, overwriteExisting);
    }

    private async buildApk(): Promise<string> {
        const gradleWrapper = new GradleWrapper(process, this.androidSdkTools, this.projectDirectory);
        await gradleWrapper.assembleRelease();
        return `${this.projectDirectory}/app/build/outputs/apk/release/app-release-unsigned.apk`;
    }

    private async optimizeApk(apkFilePath: string): Promise<string> {
        console.log("Optimizing the APK...");
        const optimizedApkPath = `${this.projectDirectory}/app-release-unsigned-aligned.apk`;
        await this.androidSdkTools.zipalign(
            apkFilePath, // input file
            optimizedApkPath, // output file
        );

        return optimizedApkPath;
    }

    private async signApk(apkFilePath: string, signingInfo: LocalKeyFileSigningOptions): Promise<string> {
        // Create a new signing key if necessary.
        if (this.apkSettings.signingMode === "new") {
            await this.createSigningKey(signingInfo);
        }
        
        const outputFile = `${this.projectDirectory}/app-release-signed.apk`;
        console.log("Signing the APK...");
        await this.androidSdkTools.apksigner(
            signingInfo.keyFilePath,
            signingInfo.storePassword,
            signingInfo.alias,
            signingInfo.keyPassword,
            apkFilePath, 
            outputFile
        );

        return outputFile;
    }

    private createTwaManifest(pwaSettings: ApkOptions): TwaManifest {
        // Bubblewrap expects a TwaManifest object.
        // We create one using our ApkSettings and signing key info.

        const signingKey = {
            path: this.signingKeyInfo?.keyFilePath || "",
            alias: this.signingKeyInfo?.alias || ""
        };
        const manifestJson: TwaManifestJson = {
            ...pwaSettings,
            shortcuts: this.createShortcuts(pwaSettings.shortcuts, pwaSettings.webManifestUrl),
            signingKey: signingKey,
            generatorApp: "PWABuilder"
        };
        const twaManifest = new TwaManifest(manifestJson);
        console.log("TWA manifest created", twaManifest);
        return twaManifest;
    }

    private createShortcuts(shortcutsJson: WebManifestShortcutJson[], manifestUrl: string): ShortcutInfo[] {
        if (!manifestUrl) {
            console.warn("Skipping app shortcuts due to empty manifest URL", manifestUrl);
            return [];
        }
        
        const maxShortcuts = 4;
        return shortcutsJson
            .filter(s => this.isValidShortcut(s))
            .map(s => this.createShortcut(s, manifestUrl))
            .slice(0, 4);
    }

    private createShortcut(shortcut: WebManifestShortcutJson, manifestUrl: string): ShortcutInfo {
        const shortNameMaxSize = 12;
        const name = shortcut.name || shortcut.short_name;
        const shortName = shortcut.short_name || shortcut.name!.substring(0, shortNameMaxSize);
        const url = new URL(shortcut.url!, manifestUrl).toString();
        const suitableIcon = findSuitableIcon(shortcut.icons!, "any");
        const iconUrl = new URL(suitableIcon!.src, manifestUrl).toString();
        return new ShortcutInfo(name!, shortName!, url, iconUrl);
    }

    private isValidShortcut(shortcut: WebManifestShortcutJson | null | undefined): boolean {
        if (!shortcut) {
            console.warn("Shortcut is invalid due to being null or undefined", shortcut);
            return false;
        }
        if (!shortcut.icons) {
            console.warn("Shorcut is invalid due to not having any icons specified", shortcut);
            return false;
        }
        if (!shortcut.url) {
            console.warn("Shortcut is invalid due to not having a URL", shortcut);
            return false;
        }
        if (!shortcut.name && !shortcut.short_name) {
            console.warn("Shortcut is invalid due to having neither a name nor short_name", shortcut);
            return false;
        }
        if(!findSuitableIcon(shortcut.icons, 'any')) {
            console.warn("Shortcut is invalid due to not finding a suitable icon", shortcut.icons);
            return false;
        }
        
        return true;
    }
}