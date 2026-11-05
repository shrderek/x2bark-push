# 第三方组件声明

本项目在实现上依赖或参考了以下开源项目，遵循其各自协议：

## 代码来源

- **[xnotif](https://github.com/yutakobayashidev/xnotif)** — MIT License
  Copyright (c) yutakobayashidev
  本项目的核心机制（Mozilla AutoPush 协议实现、Web Push aesgcm 解密、向 X 注册推送订阅、
  x-client-transaction-id 生成）移植自该项目，并按 Cloudflare Workers 运行时做了适配改造
  （`Buffer` → `atob/btoa`、EventEmitter → 直接回调、状态持久化到 Durable Object storage）。
  依 MIT 协议保留原版权声明。

- **[Bark](https://github.com/Finb/Bark)** / **[bark-server](https://github.com/Finb/bark-server)** — MIT License
  作为 iOS 端推送通道使用（仅调用 HTTP API，未包含其代码）。

## 运行时依赖的外部数据

本项目运行时（以及调用 X 接口时）会从以下仓库拉取数据，其内容适用各自仓库的条款：

- **[fa0311/latest-user-agent](https://github.com/fa0311/latest-user-agent)** — 浏览器请求头指纹模板
- **[fa0311/x-client-transaction-id-pair-dict](https://github.com/fa0311/x-client-transaction-id-pair-dict)** — x-client-transaction-id 算法所需的 pair 字典

## 商标

X、Twitter、Firefox、Mozilla、Cloudflare、Bark 等名称与标识归其各自所有者所有，
本项目与上述公司/项目无任何隶属或背书关系。
