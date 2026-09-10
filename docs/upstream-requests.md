# 下游向 SDK 提交问题与需求

集成中发现 SDK Bug、缺少通用能力、文档缺口或边界疑问时，使用
[下游集成反馈表单](https://github.com/Ancienttwo/byok-sdk/issues/new?template=downstream-integration.yml)。
一个独立问题或需求对应一个 Issue，GitHub Issue URL 是跨仓库跟踪入口。
提交前先[搜索已有 Issues](https://github.com/Ancienttwo/byok-sdk/issues)，重复问题在原单补充证据。

## 提交内容

表单收集下游项目、反馈类型、实际 SDK/运行环境版本、集成路径、期望行为、
复现或需求示例、影响程度及验收标准。私有项目无需公开源码，提供可分享的最小示例即可。
Bug 无法稳定复现时说明已观察到什么、还缺什么证据；需求说明具体输入与期望输出。
不要以推测填写根因，也不要求下游先证明一定属于 SDK。

检查正文与附件，移除 token、API key、cookie、私钥、用户对话、个人数据和完整环境变量。
support bundle 先在本地检查，只摘录相关且可分享的内容，不要自动上传原始目录或日志。

## 浏览器与 CLI

浏览器点击上方表单，填写后提交。模板须进入仓库默认分支才会出现在 GitHub 创建页面。

也可在任意下游仓库使用 GitHub CLI：将与表单相同的内容写入本地 Markdown 文件并检查，再执行：

```sh
gh issue create --repo Ancienttwo/byok-sdk \
  --title '[Downstream] 简述问题或需求' \
  --body-file /absolute/path/to/request.md
```

CLI 使用当前 GitHub 登录身份；`--repo` 明确指定上游，避免误投下游仓库。
命令会真实创建 Issue，返回 URL 后将它记录到下游任务中。CLI/API 不执行浏览器表单必填校验，
提交者仍需补齐上述内容。失败时保留本地文件并根据错误处理，不把失败当成已提交。
由 Agent 代写时先生成草稿；只有用户明确授权提交后才执行创建命令，不在 SDK runtime 自动上报。

## SDK 分诊与闭环

1. SDK 维护者检查证据、重复单及归属；信息不足时在原单请求补充。
2. 确认为 SDK 通用缺口后，记录接受范围、验收标准和关联实现 PR；
   产品调度、身份授权、部署等下游职责也在原单说明归属及理由。
3. 交付时记录验证结果、可用版本或尚未发布状态。
4. 下游在原单回填实际升级版本和集成验收结果。Issue 关闭或 PR 合并不等于已发布，
   SDK 发布也不等于下游已升级或部署。

优先级和交付时间由 SDK 分诊后明确，提交本身不构成交付承诺。
字段定义以 [downstream-integration.yml](../.github/ISSUE_TEMPLATE/downstream-integration.yml) 为准。
