plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Everything that differs between owners comes from Gradle properties
// (~/.gradle/gradle.properties, or ORG_GRADLE_PROJECT_<name> in the
// environment), never from this file. See apps/phone/README.md.
fun prop(name: String): String? = (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() }

android {
    namespace = "dev.agentx.phone"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // Must match app.android.packageName in agentx.json.
        applicationId = prop("agentxApplicationId") ?: "dev.agentx.phone"
        minSdk = maxOf(flutter.minSdkVersion, 26)
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // A release build is signed with your own key when these are set:
    // agentxKeystore (path), agentxKeystorePassword, agentxKeyAlias,
    // agentxKeyPassword. Without them the release build uses the debug key.
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
            signingConfig = signingConfigs.getByName(if (keystore != null) "release" else "debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    // Trusted Web Activity: runs the phone app in Chrome, unchanged.
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
}

flutter {
    source = "../.."
}
