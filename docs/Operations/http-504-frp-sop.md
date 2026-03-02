# HTTP 504 (FRP 链路) 诊断 SOP

目标：先判定 504 来自 `frp/反代` 还是 `Node 应用`，避免误改业务代码。

## 1. 先启动带请求追踪的 Node 日志（UTC + request_id）

```bash
LONG_REQUEST_TRACE_ENABLED=1 LONG_REQUEST_TIMEOUT_MS=180000 npm run ui 2>&1 | tee -a logs/ui-server.http.log
```

追踪范围仅包含三条长接口：
- `POST /api/chat`
- `POST /api/tasks/:id/followup`
- `POST /api/tasks/:id/rerun`

日志格式示例（统一 UTC）：
- `stage=start`：入参时间
- `stage=finish/close`：返回/连接关闭时间 + status + duration
- `stage=timeout_hint`：超过 180s 的超时提示

## 2. 手机端与本地直连做同接口对照复现

推荐用脚本一次性打 `frp` 与 `direct`，自动带同一个 `request_id`：

```bash
./scripts/http-504-probe.sh \
  "https://your-frp-domain" \
  "http://127.0.0.1:4173" \
  "/api/chat" \
  '{"message":"请给我一个较复杂的分析","thread_slug":"cat-cafe","request_id":"__REQ_ID__"}'
```

`/api/tasks/:id/followup` 与 `/api/tasks/:id/rerun` 同理，只替换路径和 JSON。

## 3. 504 发生后立即抓三层日志

```bash
# 按需传 request_id（建议从 probe 输出复制）
./scripts/collect-504-logs.sh req-20260302T120000Z-12345
```

默认日志路径（可用环境变量覆盖）：
- `NODE_LOG_PATH=logs/ui-server.http.log`
- `FRP_LOG_PATH=/var/log/frps.log`
- `NGINX_ACCESS_LOG=/var/log/nginx/access.log`
- `NGINX_ERROR_LOG=/var/log/nginx/error.log`

## 4. 判定规则

- Node 没有 `stage=start` 对应 `request_id`：请求没进应用，优先排查 `frp/反代`。
- Node 有 `stage=start` 但无 `stage=finish` 且手机 504：应用耗时超过网关阈值或链路中断。
- Node 有 `stage=finish status=200` 但手机仍 504：大概率是 `frp/反代` 回包链路超时。

## 5. Gate B 零风险兜底（先调超时到 180s）

先应用 Nginx 样例（见 `config/nginx/frp-timeout-180s.conf.example`），再观察手机端复现频率。

说明：180s 是首轮保守值，足够覆盖多数 LLM 请求，同时不至于掩盖长期挂死问题。
