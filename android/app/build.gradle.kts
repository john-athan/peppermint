import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The release key stays outside the repo (~/.config/peppermint-android). Its fingerprint is in the server's
// /.well-known/assetlinks.json: lose it and the app can no longer update itself, nor open full screen.
val releaseKeys = File(System.getProperty("user.home"), ".config/peppermint-android/keystore.properties")
    .takeIf { it.exists() }?.let { f -> Properties().apply { f.inputStream().use { load(it) } } }

android {
    namespace  = "dev.kaleve.peppermint"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.kaleve.peppermint"
        // One supported release, the current one: no version guards anywhere in the source.
        minSdk        = 36
        targetSdk     = 36
        versionCode   = 1
        versionName   = "0.1"
    }

    signingConfigs {
        if (releaseKeys != null) create("release") {
            storeFile     = File(releaseKeys.getProperty("storeFile"))
            storePassword = releaseKeys.getProperty("storePassword")
            keyAlias      = releaseKeys.getProperty("keyAlias")
            keyPassword   = releaseKeys.getProperty("keyPassword")
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled   = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    dependenciesInfo {
        includeInApk    = false
        includeInBundle = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    buildFeatures { compose = true }
    sourceSets["main"].java.srcDir("src/main/kotlin")
    sourceSets["test"].java.srcDir("src/test/kotlin")
}

dependencies {
    val bom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(bom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.work:work-runtime:2.11.2")
    // Trusted Web Activity: the app shows the web app in Chrome's engine (BrowseActivity)
    implementation("androidx.browser:browser:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    // Playback: ExoPlayer in a MediaSessionService, so the lock screen, headphones and the notification control it
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-session:1.11.1")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Everything under core/ is plain Kotlin: SSE lines, script parts, download plan, heard threshold.
    testImplementation("junit:junit:4.13.2")
}

kotlin {
    jvmToolchain(21)
}
