plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The test build is signed with agentx-test.keystore, a key committed on
// purpose so every build (yours or CI's) installs over the last one and
// keeps one fingerprint for /.well-known/assetlinks.json. It is public:
// never use it for a store release.
val runNumber = providers.environmentVariable("GITHUB_RUN_NUMBER").orNull?.toIntOrNull() ?: 1

android {
    namespace = "dev.agentx.phone"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.agentx.phone"
        minSdk = 26
        targetSdk = 34
        versionCode = runNumber
        versionName = "0.1.$runNumber"
    }

    signingConfigs {
        create("test") {
            storeFile = file("agentx-test.keystore")
            storePassword = "agentx-test"
            keyAlias = "agentx-test"
            keyPassword = "agentx-test"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("test")
        }
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        abortOnError = true
        warningsAsErrors = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")

    testImplementation("junit:junit:4.13.2")
    // Android's org.json is stubbed in local unit tests; this is the real one.
    testImplementation("org.json:json:20240303")
}
