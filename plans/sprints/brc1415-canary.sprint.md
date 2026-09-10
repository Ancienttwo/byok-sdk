# Sprint: BYOK SDK bounded canary

> **Status**: Approved
> **Backlog Schema**: 2

## PRD

Execute the approved one-group, two-slot delivery canary for the original
[Issue #177](https://github.com/Ancienttwo/byok-sdk/issues/177) and
[Issue #178](https://github.com/Ancienttwo/byok-sdk/issues/178).
The source scope and prior evidence are recorded in
[the delivery continuation](../../docs/researches/20260909-brc1415-delivery-canary.md).

Issue #177 requires the SDK README to document its existing seven namespaces,
including uiRuntime, while retaining the keys exclusion. Issue #178 retains the
verified existing packed-install smoke coverage and follows formal not-planned
closure; do not invent a replacement gap. Completion requires real Docker
worker/verifier execution, a repair PR, manual merge, automatic closeout and one
fresh group-end audit. Deployment and package release remain outside this canary.

## Backlog

| # | ID | Status | Task | Mode | Acceptance | Plan |
|---|----|---|---|---|---|---|
| 1 | 593ed20527ae483ababd1794044b107fbdbbd49df0e1d7832f273ff552be5274 | [ ] | Campaign byok-brc1415-20260909-transport group 1 slot 01: bugfix #177 | contract | Adoption sha256:824413385da47b1441bf5378100649d162cc03f77050e3627de9721aaa0c8c09; Issue body sha256:97b577bcfbfd7930b57d9e2f21b4f9b5b826ef3e37f430bb4adb9b58f3989651; local plan and module acceptance required | (pending) |
| 2 | 1ddc61ff64bbc11f8b9acf0c8cfd7539f49532c85d84b8b019a5f47899484271 | [ ] | Campaign byok-brc1415-20260909-transport group 1 slot 02: test_gap #178 | contract | Adoption sha256:824413385da47b1441bf5378100649d162cc03f77050e3627de9721aaa0c8c09; Issue body sha256:56b8d6212c854a43fccbdb64e100dd157d830c1fc9db2ed38cceb73076367508; local plan and module acceptance required | (pending) |
| 3 | 168e55cdda6f9f07d931fe30eb58432246531001699091dab62ac8bea8bcd976 | [ ] | Campaign byok-brc1415-20260909-text-connector group 1 slot 01: bugfix #177 | contract | Adoption sha256:46fb56e9c4b6800aac9cf73890318251a36de06b982cee02c135d6444c39945a; Issue body sha256:df6be6415ddf5d706b2da9135827dc16ca70f5490090795b75b88f952f36b151; local plan and module acceptance required | (pending) |
| 4 | 563d7196daeba951828f6072c7bd838a6a112900d6e2e4ae3975fefcfa7bfc5e | [ ] | Campaign byok-brc1415-20260909-text-connector group 1 slot 02: test_gap #178 | contract | Adoption sha256:46fb56e9c4b6800aac9cf73890318251a36de06b982cee02c135d6444c39945a; Issue body sha256:3f0004648ca05a2fd835675714d9b3d98e4934ad16ce390a06a0738bafb3c3e3; local plan and module acceptance required | (pending) |
| 5 | c08388fc3352a53821afc75a4b0aefbda0a79caea76e7f276f09c15a037f27da | [ ] | Campaign byok-brc1415-20260909-delivery group 1 slot 01: bugfix #177 | contract | Adoption sha256:2ec9aee590f049be10ae4c3b0b1472d5f59b2a59a86da7f3899ce2b450bb7372; Issue body sha256:d1d820c7081c8a9d3d0089b618f3904e426bc2345a6920c37a5b428c155705b9; local plan and module acceptance required | (pending) |
| 6 | 988bc2d43a4ab21f10b9e11e8b54f7fca7ac3edec11ae417d20f8efe7d1524ea | [ ] | Campaign byok-brc1415-20260909-delivery group 1 slot 02: test_gap #178 | contract | Adoption sha256:2ec9aee590f049be10ae4c3b0b1472d5f59b2a59a86da7f3899ce2b450bb7372; Issue body sha256:283c43f5645cd68b2b7759f0e0554fc9b3f3299a985df172bec9b5312e1ba5de; local plan and module acceptance required | (pending) |
| 7 | 91eeb8782318cf6e1259743a6c745908f3bd9e2cc4e49020ee34ca90e32347de | [ ] | Campaign byok-brc1415-20260909-replacement-delivery group 1 slot 01: bugfix #177 | contract | Adoption sha256:a37470f8622078aea930e342eec463da66de314d91434846e744261c80c5de2f; Issue body sha256:67ac68ab8a2fed3201ae0269826065546cca10ad70c5c594a033c778912b0d95; local plan and module acceptance required | (pending) |
| 8 | c1e3defac72a65147fe82969454ab06dabd7db2f34ec847dd06b127755576ba2 | [ ] | Campaign byok-brc1415-20260909-replacement-delivery group 1 slot 02: test_gap #178 | contract | Adoption sha256:a37470f8622078aea930e342eec463da66de314d91434846e744261c80c5de2f; Issue body sha256:bbac1e77b9a66f6911a38ef5665cc4868d8d164295cc057dec09d3fdedec66d6; local plan and module acceptance required | (pending) |
| 9 | 0870f980bd4f71db10cd4ebb4c8967afcd98eab8cf665c9f882e026ab44be444 | [ ] | Campaign byok-brc1415-20260910-settled-delivery group 1 slot 01: bugfix #177 | contract | Adoption sha256:91f6087472e603ff9e1ea3e1ab408092c4f1a01f47f5af34a231f52f7bf4a96f; Issue body sha256:61189ee15d6c851ee4eab9e539fcc0a1c2ce2642b315ffd045181dd13b140cf9; local plan and module acceptance required | (pending) |
| 10 | ac0c9b25a97b8bad52ed3759b72e852ef8c383b81943abb03084dfd5ea807a57 | [ ] | Campaign byok-brc1415-20260910-settled-delivery group 1 slot 02: test_gap #178 | contract | Adoption sha256:91f6087472e603ff9e1ea3e1ab408092c4f1a01f47f5af34a231f52f7bf4a96f; Issue body sha256:5cbb6b85a9b23ebf6bfd2e692adf9d7f70ffe67efd89e514681cb3bd56e4c03f; local plan and module acceptance required | (pending) |
| 11 | b9a942268b699293ad9b85a737d529e5c39de0cb9162a4f0b37524924c0e5aa6 | [ ] | Campaign byok-brc1415-20260910-verifier-delivery group 1 slot 01: bugfix #177 | contract | Adoption sha256:a50ac5ea48c2d3101042ad237f8e81025864179e631cc564b13f45707fab2c74; Issue body sha256:54ac80e26b8c5104415144b419ac9f104dafe50bdf0db77bc6ef0cf9d3488bae; local plan and module acceptance required | (pending) |
| 12 | e94dc79f46b6b7885db7ef1378ec2195a4cf0ccd3f7c285613551236f8761040 | [ ] | Campaign byok-brc1415-20260910-verifier-delivery group 1 slot 02: test_gap #178 | contract | Adoption sha256:a50ac5ea48c2d3101042ad237f8e81025864179e631cc564b13f45707fab2c74; Issue body sha256:debd5c46670201ad9b593b4813fc93a42727a21387e9bc2fa5625b173c231a28; local plan and module acceptance required | (pending) |
| 13 | 816a5de35d70f03ae8c216e9c717b983a3d3090026af6bc77c4559e86446a74b | [ ] | Campaign byok-brc1415-20260910-oracle-fixed-delivery-3 group 1 slot 01: bugfix #177 | contract | Adoption sha256:b3ead1bf9efa83b08e80175a963275eff58ae60910b6d8ee83d30c256cce0423; Issue body sha256:057c6d676ec22eb712a5ba8e64fb6dbe97da053a21322f19b76e2f2e6f1dff70; local plan and module acceptance required | (pending) |
| 14 | 695b6a482e5969ed47727d7694f3480386c0b5be68cfe2f0e419f7c0b988109a | [ ] | Campaign byok-brc1415-20260910-oracle-fixed-delivery-3 group 1 slot 02: test_gap #178 | contract | Adoption sha256:b3ead1bf9efa83b08e80175a963275eff58ae60910b6d8ee83d30c256cce0423; Issue body sha256:17ab5a8572be2dd6f1d164888396c3a654288aa13c46ed41bed71e815bc27191; local plan and module acceptance required | (pending) |

## Execution Log
