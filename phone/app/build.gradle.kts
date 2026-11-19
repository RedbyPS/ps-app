import java.security.MessageDigest
import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing lives OUTSIDE git: ~/.ps-gos-signing/ (see docs/release.md). Back it up: without
// that key no future update can install over the app on the developer's phone.
val signingDir = File(System.getProperty("user.home"), ".ps-gos-signing")
val signingProps = Properties().apply {
    val f = File(signingDir, "keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
// Version: scripts/release.sh bumps version.properties (code and name) for every release.
val versionProps = Properties().apply { rootProject.file("version.properties").inputStream().use { load(it) } }
// Where the phone asks for updates (V1.57, the developer, 13 Nov 2026: "Remove the IP address part so I can't see their IP
// address when [PS] asks Cincee for updates"): the public PS repo's newest GitHub release, where the release puts
// the phone's note as gos-version.json next to the APK. Not cincee.com, and no fallback to it. A build with a profile
// that names its own channel (psProfile below, or ps-build.json) asks that channel instead, for the same note name.
val updateBase = (project.findProperty("updateBase") as String?) ?: "https://github.com/RedbyPS/ps/releases/latest/download/"
val updateNote = (project.findProperty("updateNote") as String?) ?: "gos-version.json"

// V1.58 layers (core tools/assemble.mjs): an assembled tree has ps-build.json at its top (flavour, commits, the full
// profile). The app gets it and the profile as assets ps-build.json and profile.json. A build from the private tree as
// in V1.57 has neither (the folder is emptied), and the app keeps its per account answers.
val psBuildFile = rootProject.file("../ps-build.json")
val psBuildAssets = layout.buildDirectory.dir("generated/ps-build").get().asFile
// V1.71 (the developer's phone, 19 Nov 2026: it never got the own update channel his Macs follow since V1.69, so it kept asking the
// G Squad channel on GitHub and refused every APK there, signed with the G Squad key): a private build made the old way
// has no ps-build.json, so its release names the maker's layer profile itself, -PpsProfile=<file> (scripts/release.sh
// passes web ps-layer/profile.json). The file goes in unchanged as assets/profile.json and the app follows its
// channel (UpdateWhere.route). Anything wrong with it stops the build: never a quiet fall back to the G Squad channel.
val psProfileFile = (project.findProperty("psProfile") as String?)?.let { File(it) }
fun checkedLayerProfile(f: File) {
    val why = "psProfile ${f.path}"
    check(f.isFile) { "$why: no such file" }
    val p = try { groovy.json.JsonSlurper().parse(f) as? Map<*, *> } catch (e: Exception) { null } ?: error("$why: not a JSON object")
    check(p["schema"] == 1) { "$why: not a profile (schema 1)" }
    // The name rules of Profile.kt and UpdateWhere.kt both hold, and it is never the G Squad's.
    val name = p["name"] as? String ?: ""
    check(Regex("^[a-z][a-z0-9]{0,30}$").matches(name) && name != "gsquad") { "$why: no own name" }
    val ch = p["channel"] as? Map<*, *> ?: error("$why: no channel")
    when (ch["kind"]) {
        // The same test as UpdateWhere.route, so a profile that passes here is never read as the G Squad channel there.
        "url" -> { val u = ch["url"] as? String ?: ""
            check(u.startsWith("https://") && u.length > 9 && u.endsWith("/") && !u.substring(8).startsWith("/") && !u.contains(' ')) { "$why: the channel is not a plain https folder ending in /" } }
        "local" -> {}
        else -> error("$why: the channel is not an own channel (kind url or local)")
    }
}
// Checked as soon as Gradle reads this file, so a wrong profile stops any build at once.
if (psBuildFile.exists()) check(psProfileFile == null) { "psProfile and ../ps-build.json both name a profile: build with one of them" }
else if (psProfileFile != null) checkedLayerProfile(psProfileFile)
// Written by a task before every build, never while Gradle reads this file: `clean assembleRelease` (scripts/release.sh)
// deletes the build folder after that, and the APK came out without its profile (found by V1.71's first test build).
// No declared outputs, so it always runs: a build without a profile never keeps one from an earlier build.
val psBuildAssetsTask = tasks.register("psBuildAssets") {
    doLast {
        psBuildAssets.deleteRecursively()
        if (psBuildFile.exists()) {
            psBuildAssets.mkdirs()
            psBuildFile.copyTo(File(psBuildAssets, "ps-build.json"), overwrite = true)
            val profile = (groovy.json.JsonSlurper().parse(psBuildFile) as Map<*, *>)["profile"]
            if (profile != null) File(psBuildAssets, "profile.json").writeText(groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(profile)) + "\n")
        } else if (psProfileFile != null) {
            checkedLayerProfile(psProfileFile)
            psBuildAssets.mkdirs()
            psProfileFile.copyTo(File(psBuildAssets, "profile.json"), overwrite = true)
        }
    }
}

android {
    namespace = "com.cincee.ps.gos"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.cincee.ps.gos"
        minSdk = 33
        targetSdk = 36
        versionCode = versionProps.getProperty("code").toInt()
        versionName = versionProps.getProperty("name")
        buildConfigField("String", "UPDATE_BASE", "\"$updateBase\"")
        buildConfigField("String", "UPDATE_NOTE", "\"$updateNote\"")
        // The keyword of this PS version (web ps-version.json), shown next to the name.
        buildConfigField("String", "KEYWORD", "\"${versionProps.getProperty("keyword", "")}\"")
        buildConfigField("String", "SUPABASE_URL", "\"https://mxusokxekkecebwqgeru.supabase.co\"")
        // Gym scan's text reader (Tesseract) is native code: only the Pixel's arm64, plus x86_64 for the emulator.
        ndk { abiFilters += setOf("arm64-v8a", "x86_64") }
        buildConfigField("String", "SUPABASE_KEY", "\"sb_publishable_ahKGz1mm0oJyCeVJ_LKs6A_uMjYzW6B\"")
    }

    signingConfigs {
        if (signingProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = File(signingDir, signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
            // SHA-256 of the release signing certificate: an update must be signed with exactly this key.
            buildConfigField("String", "CERT_SHA256", "\"${signingProps.getProperty("certSha256", "")}\"")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            buildConfigField("String", "CERT_SHA256", "\"\"")   // debug: same key as the installed debug app only
        }
    }

    sourceSets["main"].assets.srcDir(psBuildAssets)
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging { resources.excludes += setOf("META-INF/*.version", "DebugProbesKt.bin", "kotlin-tooling-metadata.json") }
    // No Google services, no Firebase, no Play libraries: nothing here talks to Google.
    dependenciesInfo { includeInApk = false; includeInBundle = false }
}

// Gym scan: the copied Tesseract4Android AAR must be exactly the 4.8.0 release (docs/gym-scan.md has where it came from).
val tesseractAar = file("libs/tesseract4android-4.8.0.aar")
val tesseractAarSha256 = "5bcff63c12baf46bfad9776292c93df62421cec3fe52eb62f03202f49bda8c34"
val checkTesseractAar = tasks.register("checkTesseractAar") {
    inputs.file(tesseractAar)
    doLast {
        val got = MessageDigest.getInstance("SHA-256").digest(tesseractAar.readBytes())
            .joinToString("") { "%02x".format(it) }
        check(got == tesseractAarSha256) { "app/libs/tesseract4android-4.8.0.aar is not the pinned file (sha256 $got)" }
    }
}
tasks.named("preBuild") { dependsOn(checkTesseractAar) }
tasks.named("preBuild") { dependsOn(psBuildAssetsTask) }   // the build's profile in assets (above)

// Receipt scan (PS 1.65): the reading models bundled in assets/tessdata must be exactly the files from tesseract-ocr/tessdata_fast at
// commit 87416418657359cb625c412a48b6e1d6d41c29bd (docs/receipt-scan.md). Nothing is downloaded at build or run time.
val tessdataSha256 = mapOf(
    "kat.traineddata" to "557abb6f1c68bc1b286f1bdd00bb6b82f85a427a91899807dab6c2f6c7986731",
    "eng.traineddata" to "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
    "deu.traineddata" to "19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d",
)
val checkTessdata = tasks.register("checkTessdata") {
    val dir = file("src/main/assets/tessdata")
    inputs.dir(dir)
    doLast {
        for ((name, want) in tessdataSha256) {
            val got = MessageDigest.getInstance("SHA-256").digest(File(dir, name).readBytes()).joinToString("") { "%02x".format(it) }
            check(got == want) { "assets/tessdata/$name is not the pinned file (sha256 $got)" }
        }
    }
}
tasks.named("preBuild") { dependsOn(checkTessdata) }

// Gym scan: the developer's phone is arm64, so the release leaves the emulator's x86_64 copy of the text reader out (about 8 MB).
androidComponents {
    onVariants(selector().withBuildType("release")) { it.packaging.jniLibs.excludes.add("lib/x86_64/**") }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.fragment:fragment-ktx:1.9.1")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    // Gym scan (V1.59, GymScan.kt): Tesseract OCR on the phone (Apache 2.0). No Google, no network, no Play services.
    // Tesseract4Android 4.8.0, copied into the repo (app/libs) so the build has no extra download source; its SHA-256 is
    // checked before every build (checkTesseractAar below). Its one runtime dependency, androidx.annotation, comes from
    // Google's Maven through androidx.core already.
    implementation(files("libs/tesseract4android-4.8.0.aar"))
    testImplementation("junit:junit:4.13.2")   // local JVM unit tests only (RestClock); not in the APK
    testImplementation("org.json:json:20240303")   // CmdKeyTest: org.json is a stub on the JVM
}
