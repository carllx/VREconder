import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const AUTHORITATIVE_HEALTH_ROOTS = [
  path.normalize('G:\\Media\\VR'),
  path.normalize('G:\\Download')
];

export function getMediaFingerprint(filePath) {
  try {
    const canonicalPath = path.normalize(path.resolve(filePath));
    if (!fs.existsSync(canonicalPath)) return null;
    const stat = fs.statSync(canonicalPath);
    if (!stat.isFile()) return null;
    const hash = crypto.createHash('sha256');
    hash.update(`${canonicalPath}|${stat.size}|${Math.floor(stat.mtimeMs)}`);
    return {
      canonicalPath,
      sizeBytes: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      fingerprintId: hash.digest('hex').substring(0, 16)
    };
  } catch (err) {
    return null;
  }
}

export function getRootNeutralId(filePath, fingerprintId) {
  const norm = path.normalize(filePath);
  for (const root of AUTHORITATIVE_HEALTH_ROOTS) {
    if (norm.startsWith(root)) {
      const rel = path.relative(root, norm).replace(/\\/g, '/');
      const rootName = path.basename(root);
      return `${rootName}:${rel}`;
    }
  }
  return `unknown:${fingerprintId || path.basename(filePath)}`;
}

// 25 Test Artifact definitions (21 in G:\Media\VR\Render, 4 outside)
const TEST_ARTIFACT_PAIRS = [
  {
    candidatePath: 'G:\\Media\\VR\\Render\\3840_1920_crfun_avc1-Mikami Yua - SIVR102 - (HEVC_21)_CHAPTER_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\3840_1920_crfun_avc1-Mikami Yua - SIVR102 - (HEVC_21).mp4.mp4',
    evidence: 'Explicit normalization test derivative created by generate-chapter-certification-derivatives.mjs for chapter-aware hvc1 testing. Retained original canonical exists with identical media payload.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\4096_2048_crf18_avc1-Kosaka Himari - KIWVR730 - (HEVC_19)_CHAPTER_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\4096_2048_crf18_avc1-Kosaka Himari - KIWVR730 - (HEVC_19).mp4.mp4',
    evidence: 'Explicit normalization test derivative from Pair A of generate-chapter-certification-derivatives.mjs. Retained original canonical exists with byte-identical length (2,255,947,037 bytes).'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\4096_2048_crf18_avc1-Wakui Mito(Wakui Mito) - DSVR01546 - (HEVC_19)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\4096_2048_crf18_avc1-Wakui Mito(Wakui Mito) - DSVR01546 - (HEVC_19).mp4.mp4',
    evidence: 'Normalization test derivative from Issue #21 envelope test runner. Retained original canonical copy exists with byte-identical length (5,550,082,227 bytes).'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\4096_2048_crf21_avc1-Fujita kozue - NHVR220 - (HEVC_21.0)_CHAPTER_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\4096_2048_crf21_avc1-Fujita kozue - NHVR220.mp4 - (HEVC_21.0).mp4',
    evidence: 'Explicit normalization test derivative from Pair B of generate-chapter-certification-derivatives.mjs. Retained original canonical copy exists with byte-identical length (1,326,837,963 bytes).'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\4096_2048_crf21_avc1-URVRSP203(UNVRSP002) - p1 - (HEVC_19)_CHAPTER_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\4096_2048_crf21_avc1-URVRSP203(UNVRSP002) - p1 - (HEVC_19).mp4.mp4',
    evidence: 'Explicit normalization test derivative from Pair C of generate-chapter-certification-derivatives.mjs. Byte-identical SHA-256 (cd729e447aa6e4c522695808a7c9303707d2307e93136af30ae5e13794249a57) to canonical copy.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\4320_2160_crfun_av01-Ellie Nova  - Study Buddy  (DependInit).mp4 - (HEVC_23.0)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\4320_2160_crfun_av01-Ellie Nova  - Study Buddy  (DependInit).mp4 - (HEVC_23.0).mp4',
    evidence: 'Registered Slot C2 derivative in six_rep_derivatives_manifest.json with verified video/audio MD5 match (video MD5=6705f7539bc4a1030dfd8ed31fb685e5, audio MD5=d25b3ce54d9a7136c906e42a37f3acf6). Canonical copy retained.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\4320_2160_crfun_av01-Ellie Nova  - This Isnt The First Time (DependInit).mp4 - (HEVC_23.0)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\4320_2160_crfun_av01-Ellie Nova  - This Isnt The First Time (DependInit).mp4 - (HEVC_23.0).mp4',
    evidence: 'Registered Slot C1 derivative in six_rep_derivatives_manifest.json with verified video/audio MD5 match (video MD5=97d7aa2300bd196e5af36146fd252fd8, audio MD5=ea25ff2c98ad36d844dc61ca651e995f). Canonical copy retained.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Abella Danger - Are You Recording Me_merged - (HEVC)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Abella Danger - Are You Recording Me_merged - (HEVC).mp4',
    evidence: 'HVC1 test derivative created during Issue #21 compatibility matrix probe. Retained canonical copy exists.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Aimi Yoshikawa - TJVR004 - (HEVC)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Aimi Yoshikawa - TJVR004 - (HEVC).mp4',
    evidence: 'HVC1 test derivative created during Issue #21 compatibility matrix probe. Retained canonical copy exists.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Alexia Anders - AA4_merged - (HEVC)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Alexia Anders - AA4_merged - (HEVC).mp4',
    evidence: 'Registered Slot D2 derivative in b2_c2_d2_derivatives.json with verified video/audio MD5 match (vDeriv=32f9ceb9fccd4cac31363d569298ad74, aDeriv=d12617dd0b919a1a807038372de043d2). Byte-identical length (1,974,462,204 bytes) to canonical copy.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Amami Shiori - KAVR318_merged - (HEVC)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Amami Shiori - KAVR318_merged - (HEVC).mp4',
    evidence: 'HVC1 test derivative created during Issue #21 compatibility matrix probe. Retained canonical copy exists.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Aozora Hikari - IPVR244-HEVC_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Aozora Hikari - IPVR244-HEVC.mp4',
    evidence: 'HVC1 test derivative created during Issue #21 compatibility matrix probe. Retained canonical copy exists.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Hinata Hikage - URVRSP329-(HEVC_18_videotoolbox)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Hinata Hikage - URVRSP329-(HEVC_18_videotoolbox).mp4',
    evidence: 'HVC1 test derivative created during Issue #21 compatibility matrix probe. Byte-identical length (465,673,881 bytes) to canonical copy.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Hoshino Shiho(Kujou Shizuku_Aisu Minon_Aisu Moe)  -  HUNVR149(p1)-(HEVC_18)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Hoshino Shiho(Kujou Shizuku_Aisu Minon_Aisu Moe)  -  HUNVR149(p1)-(HEVC_18).mp4',
    evidence: 'HVC1 test derivative created during Issue #21 compatibility matrix probe. Byte-identical length (1,143,881,635 bytes) to canonical copy.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Hot Thai Model - Fucked In Bangkok - Jenny_ - (HEVC)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Hot Thai Model - Fucked In Bangkok - Jenny_ - (HEVC).mp4',
    evidence: 'HVC1 test derivative created during Issue #21 compatibility matrix probe. Retained canonical copy exists.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Konomi Nishimiya - KMVR-362(KVR1801)-(HEVC)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Konomi Nishimiya - KMVR-362(KVR1801)-(HEVC).mp4',
    evidence: 'Registered Slot C2 derivative in b2_c2_d2_derivatives.json with verified video/audio MD5 match (vDeriv=3789f9dea2a5cf50a5b28c2eae81b21a, aDeriv=019362108286ef6eea9f9b3d33778cff). Canonical copy retained.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Kurumi Sakura-VRKM01036-(HEVC_21)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Kurumi Sakura-VRKM01036-(HEVC_21).mp4',
    evidence: 'Registered Slot B2 derivative in six_rep_derivatives_manifest.json with verified video/audio MD5 match (vDeriv=f79c7b92c67e554e0aba805c28222625, aDeriv=3e30fdfd129beacf4a44c9364225e248). Canonical copy retained.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Lola Gets - The Complete Massage_merged - (HEVC)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Lola Gets - The Complete Massage_merged - (HEVC).mp4',
    evidence: 'HVC1 test derivative created during Issue #21 compatibility matrix probe. Retained canonical copy exists.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Mihara Honoka - HUNVR029 - (HEVC_21.0)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Mihara Honoka - HUNVR029 - (HEVC_21.0).mp4',
    evidence: 'Registered Slot A1 derivative in six_rep_derivatives_manifest.json with verified video/audio MD5 match (vDeriv=dcfbdef67279379fe35be2106053ea02, aDeriv=897a79d43a8d4da30e62554aa727e1b4). Byte-identical length (865,988,793 bytes) to canonical copy.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Misaki Azusa - HUNVR029 - (HEVC_21.0)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Misaki Azusa - HUNVR029 - (HEVC_21.0).mp4',
    evidence: 'Registered Slot A2 derivative in six_rep_derivatives_manifest.json with verified video/audio MD5 match (vDeriv=aac6578fb0bad5fef2d2aa0fb638fa30, aDeriv=07800213f53ad9386bdcec4ab3d79af4). Byte-identical length (1,445,298,114 bytes) to canonical copy.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Yamagishi Aika-PRVR081-(HEVC_23)_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\Render\\Yamagishi Aika-PRVR081-(HEVC_23).mp4',
    evidence: 'Registered Slot B1 derivative in six_rep_derivatives_manifest.json with verified video/audio MD5 match (vDeriv=600f3f30738bd9d3103a8edae79b2a5e, aDeriv=906868e4cdfae4327c8c0a083a7068b9). Canonical copy retained.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed\\8K\\Kamiki Rei - DSVR01433_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed\\8K\\Kamiki Rei - DSVR01433.mp4',
    evidence: 'HVC1 test derivative created during Issue #21 large-scale remux validation. Retained base file exists with byte-identical length (6,181,465,144 bytes).'
  },
  {
    candidatePath: 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed\\New folder\\Mikami Yua_Arata Arina (Hashimoto Arina) - SIVR033_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed\\New folder\\Mikami Yua_Arata Arina (Hashimoto Arina) - SIVR033.mp4',
    evidence: 'HVC1 test derivative created during Issue #21 large-scale remux validation. Retained base file exists with byte-identical length (3,267,249,709 bytes).'
  },
  {
    candidatePath: 'G:\\Media\\VR\\VR_Video_Processing\\04_HEVC_Conversion_Queue\\Fujimori Riho (Maeda Yumi_Yamamoto Shuri_Haruka Mirai) - DSVR891_final_libx265_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\VR_Video_Processing\\04_HEVC_Conversion_Queue\\Fujimori Riho (Maeda Yumi_Yamamoto Shuri_Haruka Mirai) - DSVR891_final_libx265.mp4',
    evidence: 'HVC1 test derivative created during Issue #21 conversion queue validation. Retained canonical copy exists.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\VR_Video_Processing\\04_HEVC_Conversion_Queue\\Itou Mayuki - KAVR233_final_libx265_HVC1_TEST.mp4',
    canonicalPath: 'G:\\Media\\VR\\VR_Video_Processing\\04_HEVC_Conversion_Queue\\Itou Mayuki - KAVR233_final_libx265.mp4',
    evidence: 'Registered Slot B2 derivative in b2_c2_d2_derivatives.json with verified video/audio MD5 match (vDeriv=3cc49fd0433226769fd638d7eda22ac0, aDeriv=d2976e114953492d21e64055475e3c7f). Canonical copy retained.'
  }
];

// 15 #26 Physical Probe Failures / Incompatibles
const INCOMPATIBLE_FAILURES = [
  {
    candidatePath: 'G:\\Media\\VR\\Render\\4096_2048_crf21_avc1-URVRSP203(UNVRSP002) - p1 - (HEVC_19).mp4.mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\4096_2048_crf21_avc1-URVRSP203(UNVRSP002) - p1 - (HEVC_19).mp4.mp4',
    evidence: 'Physical Safari probe TIMEOUT (8s exceeded). 4096x2048 HEVC Main profile with hev1 tag. Canonical production copy in user-facing Render root; must be preserved for Issue #21 normalization/remuxing.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Erika Ozaki VRKM01172 - opt - (HEVC) - VR.mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Erika Ozaki VRKM01172 - opt - (HEVC) - VR.mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. 8192x4096 (8K) HEVC Main 10 profile (10-bit) with hev1 tag. Sole copy of VRKM01172 in library; must be preserved for Issue #21 normalization.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Imai Kaho_Yayoi Mizuki - KIVR014 - (HEVC)_trim.mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Imai Kaho_Yayoi Mizuki - KIVR014 - (HEVC)_trim.mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. 2880x1440 HEVC Main 10 profile (10-bit) with hev1 tag. Sole copy of KIVR014 in library; must be preserved for Issue #21 normalization.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Majo Blonde - CUTIE CRAVES CUM - mov - (HEVC).mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Majo Blonde - CUTIE CRAVES CUM - mov - (HEVC).mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. 3840x1920 HEVC Main 10 profile (10-bit) with hev1 tag. Sole copy in library; must be preserved for Issue #21 normalization.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Matsumoto Mei - AVVR303 - 1920p- (HEVC).mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Matsumoto Mei - AVVR303 - 1920p- (HEVC).mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. 3840x1920 HEVC Main 10 profile (10-bit) with hev1 tag. Although an older/smaller encode exists (AVVR303-(HEVC_18).mp4, 583MB), this 1920p file represents the higher resolution master copy. Must be preserved for Issue #21 normalization rather than deleted.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Miura Sakura - MDVR094 - (HEVC).mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Miura Sakura - MDVR094 - (HEVC).mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. 3024x1512 HEVC Main 10 profile (10-bit) with hev1 tag. Sole copy of MDVR094 in library; must be preserved for Issue #21 normalization.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Mizuno Asahi - KMVR484 - cut - merged - (HEVC).mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Mizuno Asahi - KMVR484 - cut - merged - (HEVC).mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. 3200x1600 HEVC Main 10 profile (10-bit) with hev1 tag. Sole copy of KMVR484 in library; must be preserved for Issue #21 normalization.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Momonogi Kana - IPVR027 - (HEVC)_trim_all.mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Momonogi Kana - IPVR027 - (HEVC)_trim_all.mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. 2880x1440 HEVC Main 10 profile (10-bit) with hev1 tag. Sole copy of IPVR027 in library; must be preserved for Issue #21 normalization.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Rurucha(Arisu Ruru) - OYCVR081_merged - (HEVC).mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Rurucha(Arisu Ruru) - OYCVR081_merged - (HEVC).mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. 4320x2160 HEVC Main 10 profile (10-bit) with hev1 tag. Performer Arisu Ruru episode; sibling file in OYCVR081 is a different episode (Minami Riona). Canonical for this performer/part; must be preserved for Issue #21 normalization.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Sena Hikari - DSVR894(C) - (HEVC).mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Sena Hikari - DSVR894(C) - (HEVC).mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. 2880x1440 HEVC Main 10 profile (10-bit) with hev1 tag. Sole copy of DSVR894(C) in library; must be preserved for Issue #21 normalization.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Yumeno Aika - SIVR152 - (HEVC)_trim_all.mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Yumeno Aika - SIVR152 - (HEVC)_trim_all.mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. 2880x1440 HEVC Main 10 profile (10-bit) with hev1 tag. Sole copy of SIVR152 in library (SIVR294 is an entirely different catalog work); must be preserved for Issue #21 normalization.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\VR_Video_Processing\\(upload 180 camera reference)VRKM1306\\8192_4096_crf23_hev1-Sayama Ai - MDVR257(p1).mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\VR_Video_Processing\\(upload 180 camera reference)VRKM1306\\8192_4096_crf23_hev1-Sayama Ai - MDVR257(p1).mp4',
    evidence: 'Physical Safari probe TIMEOUT (8s exceeded). 8192x4096 (8K) HEVC Main profile reference encode. Distinct 8K master representation from the 4K Render edition (Sayama Ai - MDVR257(p1)-(HEVC_23).mp4); must be preserved for Issue #21 normalization.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed\\8K\\Oguri Misao (Momose Asuka) - SAVR01127.mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed\\8K\\Oguri Misao (Momose Asuka) - SAVR01127.mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. 8192x4096 (8K) HEVC Main 10 profile (10-bit) with hev1 tag. Sole copy of SAVR01127 in library; must be preserved for Issue #21 normalization.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed\\8K\\Shizuki Yukari - AQULA126.mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed\\8K\\Shizuki Yukari - AQULA126.mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. 8192x4096 (8K) HEVC Main 10 profile (10-bit) with hev1 tag. Sole copy of AQULA126 in library; must be preserved for Issue #21 normalization.'
  },
  {
    candidatePath: 'G:\\Download\\vrkm-1453\\4k2.com@vrkm01453_25_4k.mp4',
    classification: 'CANONICAL_NEEDS_NORMALIZATION',
    retainedCanonicalPath: 'G:\\Download\\vrkm-1453\\4k2.com@vrkm01453_25_4k.mp4',
    evidence: 'Physical Safari probe MEDIA_ERROR Code 4. Episode #25 of VRKM1453 series in G:\\Download root. Canonical part of 40-part set; must be preserved for Issue #21 normalization.'
  }
];

// Sample multi-version ambiguous pairs inspected to enforce RELATIONSHIP_UNCERTAIN
const AMBIGUOUS_VERSION_PAIRS = [
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Matsumoto Mei - AVVR303-(HEVC_18).mp4',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Matsumoto Mei - AVVR303 - 1920p- (HEVC).mp4',
    reason: 'Both represent AVVR303 but have distinct resolutions/encodes (1080p vs 1920p). While AVVR303-1920p failed Safari probe (10-bit), neither is a confirmed byte/stream supersession of the other. Retained unmutated under RELATIONSHIP_UNCERTAIN pending intentional human curation.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Miyazawa Chiharu - DSVR857-(HEVC_21_videotoolbox).mp4',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Miyazawa Chiharu - DSVR857_merged - (HEVC_21.0).mp4',
    reason: 'Both represent DSVR857 with different edit/encoder tags (merged vs videotoolbox). Neither is proven to strictly supersede the other. Retained unmutated under RELATIONSHIP_UNCERTAIN.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Murakami Yuuka - SIVR334 - (HEVC).mp4',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Murakami Yuuka - SIVR334_merged - (HEVC).mp4',
    reason: 'Differing cut/merge versions of SIVR334. Naming difference alone is insufficient deletion authority. Retained unmutated under RELATIONSHIP_UNCERTAIN.'
  },
  {
    candidatePath: 'G:\\Media\\VR\\Render\\Sano Yuma - KAVR340_merged - (HEVC).mp4',
    retainedCanonicalPath: 'G:\\Media\\VR\\Render\\Sano Yuma - KAVR340_merged - (HEVC_21.0).mp4',
    reason: 'Subtle CRF versioning (HEVC vs HEVC_21.0). Naming difference alone is insufficient deletion authority. Retained unmutated under RELATIONSHIP_UNCERTAIN.'
  }
];

export function buildManifest() {
  const factsCache = JSON.parse(fs.readFileSync('prototype/lan_secure_origin/media_health_facts_cache.json', 'utf8'));
  const lines = fs.readFileSync('prototype/lan_secure_origin/media_health_registry.jsonl', 'utf8').trim().split('\n').filter(Boolean);
  const registryMap = new Map();
  for (const l of lines) {
    const d = JSON.parse(l);
    registryMap.set(d.filePath, d);
  }

  function findFact(targetPath) {
    for (const [k, v] of Object.entries(factsCache)) {
      if (v.filePath === targetPath || v.canonicalPath === targetPath || (v.fingerprint && v.fingerprint.canonicalPath === targetPath)) {
        return v;
      }
    }
    return null;
  }

  const groups = [];
  let groupIdSeq = 1;

  // 1. Process 25 Test Artifacts
  for (const item of TEST_ARTIFACT_PAIRS) {
    const cFp = getMediaFingerprint(item.candidatePath);
    const rFp = getMediaFingerprint(item.canonicalPath);
    if (!cFp) throw new Error(`Candidate file missing: ${item.candidatePath}`);
    if (!rFp) throw new Error(`Retained canonical file missing: ${item.canonicalPath}`);

    const cFact = findFact(item.candidatePath);
    const rFact = findFact(item.canonicalPath);

    const cHealth = registryMap.get(item.candidatePath);
    const rHealth = registryMap.get(item.canonicalPath);

    const groupId = `GRP-TEST-${String(groupIdSeq++).padStart(3, '0')}`;
    groups.push({
      groupId,
      candidatePath: item.candidatePath,
      candidateNeutralId: getRootNeutralId(item.candidatePath, cFp.fingerprintId),
      candidateFingerprint: cFp.fingerprintId,
      candidateSize: cFp.sizeBytes,
      classification: 'TEST_ARTIFACT',
      retainedCanonicalPath: item.canonicalPath,
      retainedCanonicalNeutralId: getRootNeutralId(item.canonicalPath, rFp.fingerprintId),
      retainedCanonicalFingerprint: rFp.fingerprintId,
      candidateHealthResult: cHealth ? cHealth.probeVerdict : null,
      canonicalHealthResult: rHealth ? rHealth.probeVerdict : null,
      codecContainerFacts: {
        candidate: {
          codec: cFact?.video?.codec || 'hevc',
          codecTag: cFact?.video?.codecTag || 'hvc1',
          profile: cFact?.video?.profile || 'Main',
          width: cFact?.video?.width || null,
          height: cFact?.video?.height || null
        },
        canonical: {
          codec: rFact?.video?.codec || 'hevc',
          codecTag: rFact?.video?.codecTag || 'hev1',
          profile: rFact?.video?.profile || 'Main',
          width: rFact?.video?.width || null,
          height: rFact?.video?.height || null
        }
      },
      exactEvidenceBasis: item.evidence,
      confidence: 'EXACT_PROVENANCE',
      deletionEligible: true,
      proposedAction: 'DELETE_AFTER_VERIFY_RETAINED',
      estimatedReclaimedBytes: cFp.sizeBytes,
      uncertaintyReason: null
    });
  }

  // 2. Process 15 Physical Incompatible / Failure Items
  let incompSeq = 1;
  for (const item of INCOMPATIBLE_FAILURES) {
    const cFp = getMediaFingerprint(item.candidatePath);
    if (!cFp) throw new Error(`Candidate file missing: ${item.candidatePath}`);

    const cFact = findFact(item.candidatePath);
    const cHealth = registryMap.get(item.candidatePath);

    const groupId = `GRP-INCOMPAT-${String(incompSeq++).padStart(3, '0')}`;
    groups.push({
      groupId,
      candidatePath: item.candidatePath,
      candidateNeutralId: getRootNeutralId(item.candidatePath, cFp.fingerprintId),
      candidateFingerprint: cFp.fingerprintId,
      candidateSize: cFp.sizeBytes,
      classification: item.classification,
      retainedCanonicalPath: item.retainedCanonicalPath,
      retainedCanonicalNeutralId: getRootNeutralId(item.retainedCanonicalPath, cFp.fingerprintId),
      retainedCanonicalFingerprint: cFp.fingerprintId,
      candidateHealthResult: cHealth ? cHealth.probeVerdict : null,
      canonicalHealthResult: cHealth ? cHealth.probeVerdict : null,
      codecContainerFacts: {
        candidate: {
          codec: cFact?.video?.codec || 'hevc',
          codecTag: cFact?.video?.codecTag || 'hev1',
          profile: cFact?.video?.profile || null,
          width: cFact?.video?.width || null,
          height: cFact?.video?.height || null
        },
        canonical: {
          codec: cFact?.video?.codec || 'hevc',
          codecTag: cFact?.video?.codecTag || 'hev1',
          profile: cFact?.video?.profile || null,
          width: cFact?.video?.width || null,
          height: cFact?.video?.height || null
        }
      },
      exactEvidenceBasis: item.evidence,
      confidence: 'AUTHORITATIVE_CANONICAL',
      deletionEligible: false,
      proposedAction: 'PRESERVE_FOR_ISSUE21_NORMALIZATION',
      estimatedReclaimedBytes: 0,
      uncertaintyReason: null
    });
  }

  // 3. Process Ambiguous Version Pairs
  let uncertSeq = 1;
  for (const item of AMBIGUOUS_VERSION_PAIRS) {
    const cFp = getMediaFingerprint(item.candidatePath);
    const rFp = getMediaFingerprint(item.retainedCanonicalPath);
    if (!cFp) throw new Error(`Candidate file missing: ${item.candidatePath}`);
    if (!rFp) throw new Error(`Retained canonical file missing: ${item.retainedCanonicalPath}`);

    const cFact = findFact(item.candidatePath);
    const rFact = findFact(item.retainedCanonicalPath);

    const cHealth = registryMap.get(item.candidatePath);
    const rHealth = registryMap.get(item.retainedCanonicalPath);

    const groupId = `GRP-UNCERTAIN-${String(uncertSeq++).padStart(3, '0')}`;
    groups.push({
      groupId,
      candidatePath: item.candidatePath,
      candidateNeutralId: getRootNeutralId(item.candidatePath, cFp.fingerprintId),
      candidateFingerprint: cFp.fingerprintId,
      candidateSize: cFp.sizeBytes,
      classification: 'RELATIONSHIP_UNCERTAIN',
      retainedCanonicalPath: item.retainedCanonicalPath,
      retainedCanonicalNeutralId: getRootNeutralId(item.retainedCanonicalPath, rFp.fingerprintId),
      retainedCanonicalFingerprint: rFp.fingerprintId,
      candidateHealthResult: cHealth ? cHealth.probeVerdict : null,
      canonicalHealthResult: rHealth ? rHealth.probeVerdict : null,
      codecContainerFacts: {
        candidate: {
          codec: cFact?.video?.codec || 'hevc',
          codecTag: cFact?.video?.codecTag || null,
          profile: cFact?.video?.profile || null,
          width: cFact?.video?.width || null,
          height: cFact?.video?.height || null
        },
        canonical: {
          codec: rFact?.video?.codec || 'hevc',
          codecTag: rFact?.video?.codecTag || null,
          profile: rFact?.video?.profile || null,
          width: rFact?.video?.width || null,
          height: rFact?.video?.height || null
        }
      },
      exactEvidenceBasis: item.reason,
      confidence: 'LOW_AMBIGUOUS',
      deletionEligible: false,
      proposedAction: 'LEAVE_UNTOUCHED',
      estimatedReclaimedBytes: 0,
      uncertaintyReason: item.reason
    });
  }

  // Totals calculations
  const totals = {
    groupsInspected: groups.length,
    CANONICAL_KEEP: 0,
    CANONICAL_NEEDS_NORMALIZATION: groups.filter(g => g.classification === 'CANONICAL_NEEDS_NORMALIZATION').length,
    SUPERSEDED_DERIVATIVE: groups.filter(g => g.classification === 'SUPERSEDED_DERIVATIVE').length,
    TEST_ARTIFACT: groups.filter(g => g.classification === 'TEST_ARTIFACT').length,
    TRUE_DUPLICATE: groups.filter(g => g.classification === 'TRUE_DUPLICATE').length,
    TRANSACTION_RESIDUE: 0,
    RELATIONSHIP_UNCERTAIN: groups.filter(g => g.classification === 'RELATIONSHIP_UNCERTAIN').length,
    deletionEligibleCount: groups.filter(g => g.deletionEligible).length,
    deletionEligibleBytes: groups.filter(g => g.deletionEligible).reduce((acc, g) => acc + g.estimatedReclaimedBytes, 0),
    userVisibleRenderDeletionEligibleCount: groups.filter(g => g.deletionEligible && g.candidatePath.startsWith('G:\\Media\\VR\\Render')).length,
    userVisibleRenderDeletionEligibleBytes: groups.filter(g => g.deletionEligible && g.candidatePath.startsWith('G:\\Media\\VR\\Render')).reduce((acc, g) => acc + g.estimatedReclaimedBytes, 0)
  };

  return {
    manifestVersion: '1.0.0-issue-27',
    generatedAt: new Date().toISOString(),
    gate: 'GATE_A_READONLY',
    zeroMediaMutationEnforced: true,
    totals,
    groups
  };
}

if (process.argv[1] && process.argv[1].endsWith('generate_asset_manifest.mjs')) {
  const manifest = buildManifest();
  const outPath = 'prototype/lan_secure_origin/asset_integrity_cleanup_manifest.json';
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Manifest generated successfully at ${outPath}`);
  console.log('Totals:', JSON.stringify(manifest.totals, null, 2));
}
