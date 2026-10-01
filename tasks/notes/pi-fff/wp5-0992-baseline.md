# Pi 0.99.2 inherited baseline

{
  "primary_branch": "pi-0.99.2-context-usage",
  "base_commit": "708ed45b275d7d0cceeb6b61eb392c7d7b4efed9",
  "backup": "/tmp/byok-fff-0992-import-i07t8qr1",
  "included": [
    {
      "path": "CHANGELOG.md",
      "primary_sha256": "5834a7c16098de1f14e6bf8d283cce84fc13b168773795dc185c69a1ab880d4c",
      "base_sha256": "a118de9478a77d6dc73dae14788b6f9e3576c85bd905d9bb074deed5c7cc1b46"
    },
    {
      "path": "README.md",
      "primary_sha256": "001e1385e1693b2ee3830e6756ea526162b6ff1a6494a7c5e543489c9a229e39",
      "base_sha256": "8229340d054de0a0977916068319c4a96049b3036a870dc2c488d8f8497454c1"
    },
    {
      "path": "bun.lock",
      "primary_sha256": "1124383dffc9574ba524423752ce1f18ce50cbd9f08ccef71d99e82cf34c7ffd",
      "base_sha256": "9f61107461d593cf502803fc01719ee2fc0bb4a4892efb547f751b1ffc5f46e8"
    },
    {
      "path": "docs/spec.md",
      "primary_sha256": "68c58376714a1e60e6a059a147c5c14e5464b6c9d8f1342c3382cb51ebe8012f",
      "base_sha256": "facdb64ca425e6b0dd161fdd182dda3e5a7d11b9c02be695efa7f0aedea02ade"
    },
    {
      "path": "package.json",
      "primary_sha256": "07f431f8ed220a2b6a0aa4738055cca25786b016511e61a8ed6316df1b0f88fa",
      "base_sha256": "692d1632a485349c2ecd10a4f994d384aedc675bd3e91d9763f39875c8957512"
    },
    {
      "path": "packages/client/package.json",
      "primary_sha256": "76dae5470b89377bca55059afe73dcb76b7d05a28c3b3c8e7f616745d3b50a18",
      "base_sha256": "71d76f463ba17d6f9187b4c69f826afbb7cbb8c4905e2e394421cee25d8e032f"
    },
    {
      "path": "packages/client/src/__tests__/fixtures/pi-compile-purity-probe.mjs",
      "primary_sha256": "c66ef2a7a32e5f6afc7200f4a5225e495a7a2dad283a80c0d99f6c03b9a95a1b",
      "base_sha256": "a58bc967faff618a4452ccdde904832cf27c0fab2a1811b02b21bf0d63b05989"
    },
    {
      "path": "packages/client/src/__tests__/pi-input-preparation.test.ts",
      "primary_sha256": "3843ad8f1d86ca5e15bb350ae17a25198963e2a8cf28d19bdf14572b2910f690",
      "base_sha256": "7bea4474db21875d63aacf88022f38f61fe777f235052720c6c9f07622a8f250"
    },
    {
      "path": "packages/client/src/adapters/pi/__tests__/official-pi-conformance-compat.test.ts",
      "primary_sha256": "23dd89030359e20b817eb5c154af3c51543c74a99f693d77fb07bdfcc365925a",
      "base_sha256": "f9b5acf7172e8ef1827830c051241e48cf7833d7b33ae57eb8eb5ef5094378f5"
    },
    {
      "path": "packages/client/src/adapters/pi/__tests__/official-pi-conformance-compile.test.ts",
      "primary_sha256": "8116631d7572cfbb0e9189b27173c79342116120f17497f1e49a935b56efce23",
      "base_sha256": "0f0fa4de5e3efc24eb7a091234ea7fe48e79150dbe0845c47fd95d8b4bbc05da"
    },
    {
      "path": "packages/client/src/adapters/pi/__tests__/official-pi-conformance-enforcement.test.ts",
      "primary_sha256": "08214581f4210b8c728f8fcd7e0f410a11cf8489254e12b0462f136a334d0bc1",
      "base_sha256": "bad99a6943b6624c20d28458adb4ba7a97c5aed903704a869a609271521be301"
    },
    {
      "path": "packages/client/src/adapters/pi/__tests__/official-pi-fixture.ts",
      "primary_sha256": "db86c199343d058c1610e8888607e424509ae77f4cf4b471cfe3dd384ad06d1f",
      "base_sha256": "f452ade0d5ab335d75370c4526edbf24de149611ad23e7c14468b86ae986a717"
    },
    {
      "path": "packages/client/src/adapters/pi/__tests__/prepared-lane-official.test.ts",
      "primary_sha256": "047d867cdc74ee169ce6e74ada92a5cc7ebf05a43aec23950c617e3db6e14151",
      "base_sha256": "26f72877d79de89d86fcfb2c6ffe6f6e8858fb188ffb27291d99887bea91e4bc"
    },
    {
      "path": "packages/client/src/adapters/pi/input-preparation.ts",
      "primary_sha256": "62a701376903c79754102310bf87deb0ecd68037583569435e49ec4017dc9b14",
      "base_sha256": "fd12f6838739b82ef2d3c50072899aea44950d36476f09ae8611a057e74bce00"
    },
    {
      "path": "packages/client/src/adapters/pi/official-pi-closure.json",
      "primary_sha256": "8f89afb4ad96c1783f175386aa0d6c66eb2473dc0e9b281c2ccf5268ae687476",
      "base_sha256": "ba80555281c88a5b96edfdf5c3d5f35571c0fd84e07f5024f12161d8d39d9aae"
    },
    {
      "path": "packages/client/src/adapters/pi/pi-export-assets.source.json",
      "primary_sha256": "cba421039a4d8af2b5311451d790b7472ad009506a74c390e0b2ec07df9d38c6",
      "base_sha256": "9836bd941bf1824b9806a41a442d4d90f36f4d0ccbb99b35fd40872aa645f144"
    },
    {
      "path": "packages/client/src/daemon/input-preparation-service.ts",
      "primary_sha256": "d295c37680c6981104b927dceb380b23e6d77ea1cc4e0d3693bb76a1cab0d94b",
      "base_sha256": "2836815f1d84424aa60c367bf8ddfa1a6cba9a1258c2d5e740144543d7fdf1f6"
    },
    {
      "path": "packages/client/src/util/rpc-frame.ts",
      "primary_sha256": "d696172be4cc062f01f2388386607f4507a3d1416dddd80328c7e88a7d14035b",
      "base_sha256": "6d26c0854d6dd8ef5e5b52daac1be6f8b5cdfa7026087751ded2261255338350"
    },
    {
      "path": "packages/client/vendor/THIRD-PARTY.md",
      "primary_sha256": "fcde3fc5c35f1ae467d0654d13f9631aece876ab3dd412ce41e027b45de3485f",
      "base_sha256": "3e701b65cf9d41f31b7291f2c37fa5fcc021aeb6dcb3db6df1b81903dcb87ddf"
    },
    {
      "path": "packages/client/vendor/third-party-manifest.json",
      "primary_sha256": "682c73e652a8219618d3de2d3424224c74ec1bd2bcf012536ab899abaea0722d",
      "base_sha256": "c435aab261a8456fe1ca499c811eb63c5207ce016700ac5aa51e7bcdf7bf929f"
    },
    {
      "path": "scripts/release/beta-release.test.mjs",
      "primary_sha256": "7ca5da81c6c88e9553a7cde79e6de588dd0c5bac55f87ec86264038332e019e1",
      "base_sha256": "b5bf4831f3de8fecd06823742d38929729d8e814ac5269c6dda1754d1eda9e86"
    },
    {
      "path": "scripts/release/pack-and-smoke.test.mjs",
      "primary_sha256": "93347ec98b7a4b595f37a781e64d871ff51a27d8392fbee10f0ef0a5e734731f",
      "base_sha256": "10e399a33380868888cf5c5e53bf9455b2938a9080a86d1083dcb1998fe4e575"
    },
    {
      "path": "tasks/todos.md",
      "primary_sha256": "0b75f3054cf27b2bb10e322c10fad6407250b88d2e280a14c76dc79e75bfa75c",
      "base_sha256": "c31f0ac5e7121bc35e79a0c4eab96d8f843e1fef5814c3a9b02b9a27bc7da159"
    }
  ],
  "excluded": [
    "docs/researches/README.md",
    "plans/plan-20261001-0132-context-usage-gap.md",
    "docs/researches/2026-10-01_oar-extraction-assessment.md"
  ]
}

All 23 files are inherited upgrade state. The 0.99.2 runner/session-manager/runtime-dispose APIs match 0.99.1; FFF receives no implementation redesign. Revalidation required.
