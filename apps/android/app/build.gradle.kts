plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Everything that differs between owners comes from Gradle properties
// (gradle.properties, ~/.gradle/gradle.properties or -P on the command
// line), never from this file. See apps/android/README.md.
fun prop(name: String): String? = (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() }

android {
    namespace = "dev.agentx.phone"
    compileSdk = 35

    defaultConfig {
        applicationId = prop("agentxApplicationId") ?: "dev.agentx.phone"
        minSdk = 26
        targetSdk = 35
        versionCode = (prop("agentxVersionCode") ?: "1").toInt()
        versionName = prop("agentxVersionName") ?: "0.1.0"
    }

    // A release build is signed with your own key when these are set:
    // agentxKeystore (path), agentxKeystorePassword, agentxKeyAlias,
    // agentxKeyPassword. Without them only the debug build is signed.
    val keystore = prop("agentxKeystore")
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = prop("agentxKeystorePassword")
                keyAlias = prop("agentxKeyAlias")
                keyPassword = prop("agentxKeyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Trusted Web Activity: runs the phone app in Chrome, unchanged.
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
    // Lets Chrome give the phone app the location through this app (#684).
    implementation("com.google.androidbrowserhelper:locationdelegation:1.1.1")
    // OS geofences: the phone, not the app, watches the places.
    implementation("com.google.android.gms:play-services-location:21.3.0")
    // Reports and place checks that survive the app being closed.
    implementation("androidx.work:work-runtime:2.9.1")

    testImplementation("junit:junit:4.13.2")
    // The real org.json for unit tests (Android's is a stub off the phone).
    testImplementation("org.json:json:20240303")
}
