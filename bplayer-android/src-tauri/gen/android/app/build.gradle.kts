import java.io.FileInputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Build stamp so a sideloaded APK can be identified at a glance: debug and release share the
// same versionName, and without this there is no way to tell whether the package installed on
// the phone is the one that was just built. Both tracks are built with the same
// BPLAYER_BUILD_STAMP so they stay comparable.
// Fully qualified `java.text.*` cannot be used here: Gradle's Kotlin DSL shadows `java` with
// the Project.java extension, so the classes have to come in via import at the top.
val bplayerBuildStamp: String = System.getenv("BPLAYER_BUILD_STAMP")
    ?: SimpleDateFormat("MMdd-HHmm").format(Date())

android {
    compileSdk = 37
    namespace = "com.danmuku.bplayer.android"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        manifestPlaceholders["appName"] = "Bplayer"
        applicationId = "com.danmuku.bplayer.android"
        minSdk = 26
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        // Build stamp so a sideloaded APK can be identified at a glance: debug and release
        // share the same versionName, and without this there is no way to tell whether the
        // package installed on the phone is the one that was just built. Both tracks are
        // built back to back with the same BPLAYER_BUILD_STAMP so they stay comparable.
        buildConfigField("String", "BUILD_STAMP", "\"$bplayerBuildStamp\"")
    }
    // Release signing comes from gen/android/keystore.properties, which is never committed.
    // When the file is absent the release build keeps the default debug key so local builds
    // still work; published release artifacts always use the real key.
    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            if (keystorePropertiesFile.exists()) {
                val keystoreProperties = Properties()
                FileInputStream(keystorePropertiesFile).use { keystoreProperties.load(it) }
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("password")
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("password")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            // Debug and release must be installable side by side: separate application ids keep
            // their data directories and update tracks apart, and the launcher label tells them
            // apart. Providers and authorities follow applicationId automatically.
            manifestPlaceholders["appName"] = "Bplayer debug"
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
    packaging {
        resources.excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"
        resources.merges += setOf("META-INF/LICENSE.md", "META-INF/NOTICE.md", "META-INF/LICENSE", "META-INF/NOTICE")
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("dev.ffmpegkit-maintained:ffmpeg-kit-min:8.1.7")
    implementation("com.arthenica:smart-exception-java:0.2.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("com.hierynomus:smbj:0.15.0")
    implementation("com.rapid7.client:dcerpc:0.12.13") {
        exclude(group = "com.hierynomus", module = "smbj")
        exclude(group = "org.bouncycastle")
        exclude(group = "commons-io", module = "commons-io")
        exclude(group = "org.apache.commons", module = "commons-lang3")
    }
    implementation("commons-io:commons-io:2.20.0")
    implementation("org.apache.commons:commons-lang3:3.18.0")
    implementation("com.hierynomus:sshj:0.41.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.1")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("org.bouncycastle:bcprov-jdk18on:1.85.2")
    implementation("org.bouncycastle:bcpkix-jdk18on:1.85")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
// The legacy DSL in this project ignores applicationIdSuffix, so set the debug application id
// through the variant API instead; debug and release then install side by side.
androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        variant.applicationId.set(variant.applicationId.get() + ".debug")
    }
}
