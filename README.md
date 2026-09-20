# Mocket Playground

一个无需本地 MoonBit 工具链的浏览器内 Mocket 开发环境。它使用 Moonpad 的浏览器编译器生成 JavaScript，将结果写入 WebContainer，并由其中的 Node.js 实际启动 Mocket 服务。

## 开箱即用的依赖

首次运行包含 `@mocket` 的项目时，页面会从同站点加载预构建的 JS 依赖包：

- `oboard/mocket`
- `moonbitlang/async` 及其 JS target 传递依赖
- Mocket 的 `cors`、`uri`、`multipart`、`internal/header` 等 package
- `moonbitlang/x` 的编译期/运行期依赖

产物位于 `public/moonbit/mocket-js-artifacts.json.gz`，包含 33 个 `.mi` 接口和 33 个 `.core` 文件。因此普通用户不需要安装 MoonBit、Mooncakes 或 npm 依赖即可编译和运行 Mocket 示例。

## 使用方式

1. 启动开发服务器：`vp dev`。
2. 在 Explorer 中编辑 `src/main.mbt`，或从 **Examples** 选择路由示例。
3. 点击 **Run**：浏览器链接 MoonBit 到 JavaScript，WebContainer Node 启动生成的服务。
4. 在右侧 **API client** 输入例如 `GET /hello/MoonBit` 并发送请求。

### 终端中的 Moon Web

WebContainer 终端安装了一个 **Moon Web**（浏览器托管的 Moon 移植），它通过文件系统桥接到同一个 Moonpad 编译器与离线 Mocket + async artifact bundle：

```bash
moon version
moon check
moon build --target js
moon run --target js
```

`moon build` 会把 JavaScript 写到 `_build/js/debug/build/`；`moon run` 会在 WebContainer Node 中执行该产物。因此它并不是把上游 Rust `moon` 二进制伪装成 Wasm，而是在浏览器能够真实提供的编译和 Node 运行时之上实现的兼容命令层。官方 Wasm archive 仍直接提供 `moonc`、`moonfmt` 和 `mooninfo`。

目前 Moon Web 只支持当前工作区与 JavaScript target，不支持 `moon add`、`moon update`、registry/Git 依赖下载、`moon ide`、`moon test`、watch mode、native target 或 wasm target。

API Client 的请求会由 WebContainer 内的 Node 发往 `127.0.0.1:4000`，而不是由外层浏览器直接跨域访问预览域名；这使 Postman 风格的本地请求能稳定访问真实运行中的 Mocket 服务。

## 更新内置 Mocket 依赖包

在 Mocket 仓库编译 JS release 产物后，重新生成离线包：

```bash
moon build --target js --release examples/route
MOCKET_SOURCE=/absolute/path/to/oboard/mocket node scripts/generate-mocket-artifacts.mjs
```

将生成的 `public/moonbit/mocket-js-artifacts.json.gz` 一起提交。生成脚本只收集 JS target 的依赖接口和 core 文件，并排除 examples。

## 验证

```bash
vp check
vp run build
vp test
```

当前仓库还没有测试文件，因此 `vp test` 会按 Vitest 的默认行为以 `No test files found` 退出；前两条命令应通过。
