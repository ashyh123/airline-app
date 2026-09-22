# 机场加油车智能调度系统

这是根据《机场加油车调度子系统软件需求规格说明书》实现的可运行原型。它围绕“航班数据导入 / 事件接入 → 智能调度 → 人工微调 → 工单执行 → 异常预警 → 现场播报”的闭环设计，适合课程设计演示、后续工程化迭代和接口联调。

## 已实现的业务能力

- 三角色登录与权限隔离：调度人员、加油人员、系统管理员分别进入独立工作台；接口同时校验角色与用户身份。
- 航班数据导入：调度人员可批量导入或按航班号更新航班计划，支持 UTF-8 的 CSV 与 JSON 两种格式。
- 现场情况播报：调度人员可发布普通 / 需关注 / 紧急三个级别的现场播报，出现在右上角“运行通知”中，可关联具体航班。
- A-OCS 航班事件接口：支持落地、延误、取消和离港；使用 `eventId` 去重，避免重复消息造成重复派工。
- 智能分配：基于航班优先级、加油车可用状态、剩余油量和机坪示意距离的可解释启发式分配。
- 人机协同：调度员可将工单改派给合格车辆，并将这项决定锁定，不会被后续自动调度覆盖。
- 加油作业执行：待执行 → 作业中 → 已完成的合法状态流转；完成作业时必须提交车辆当前油量，系统据此更新车辆剩余油量并恢复可用状态；异常必须填写原因，车辆自动转维修并生成风险告警。
- 指挥态势：俯视风格的机坪态势图（航站楼、机位、滑行道、跑道、车辆位置）、车辆油量、活动工单、风险列表、利用率和按时保障率。
- 安全边界：油量不足、不可用车辆、非法状态流转、非法事件和越权访问均会返回明确错误，不会静默处理。

## 角色工作台

| 角色 | 可用功能 |
| --- | --- |
| 调度人员 | 查看全场态势、生成智能方案、人工改派和锁定工单、处置风险预警、导入航班数据、发布现场播报。不能代替司机提交作业状态。 |
| 加油人员 | 只能查看本人车辆的待办与进行中工单；可上报开始、完成（须提交当前油量）和带原因的异常。 |
| 系统管理员 | 原有“航班导入”与“现场播报”功能已整体移交调度人员；管理员角色保留作系统级扩展（如账号管理）。 |

演示登录页采用账号密码，不让使用者选择角色；系统根据账号权限自动进入工作台。可用演示账号为 `dispatch01 / dispatch123`、`driver01~driver03 / driver123`、`admin01 / admin123`。实际部署时应将演示凭据替换为机场统一身份认证、密码哈希、会话过期和网关令牌校验。

## 界面说明

- 调度工作台采用“左侧功能指引 + 分区内容”的布局：功能指引提供态势总览、机坪态势、风险预警、任务时间轴、作业工单、资源与指标、航班导入、现场播报八个分区的快速定位。
- 机坪态势图为 SVG 俯视示意：草地、水泥机坪、T1 航站楼与登机口、滑行道、跑道（含编号与中线）及航班停机位；红色飞机为高优先级航班，车标颜色表示车辆状态（绿：可用，蓝：已预留/作业中，灰：维修中）。
- 顶栏右上角提供运行通知（播报、风险、工单动态）与退出登录；退出后清空会话并返回登录页。

## 架构

```text
A-OCS / 模拟事件 ──POST /api/events──> 调度服务
航班导入（CSV/JSON）──POST /api/admin/flights/import──> ┤
现场播报 ──POST /api/admin/broadcasts──>               ├─ SQLite（航班、车辆、工单、告警、播报、事件去重）
调度指挥台 / 司机端 <──JSON API─────────────────────────┤
                                                       └─ Scheduler（当前：启发式；生产：OR-Tools 可替换）
```

主要接口（除登录外均需 `Authorization: Bearer <token>`）：

| 方法与路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/auth/login` | 公开 | 账号密码登录，返回用户信息与令牌 |
| `GET /api/overview` | 调度 | 全场态势（统计、工单、车辆、航班、告警、播报） |
| `POST /api/dispatch/optimize` | 调度 | 生成 / 更新智能调度方案 |
| `POST /api/tasks/{id}/override` | 调度 | 人工微调并锁定工单 |
| `GET /api/alerts/{id}/recommendations`、`POST /api/alerts/{id}/resolve` | 调度 | 风险处置建议与归档 |
| `GET /api/admin/flights`、`POST /api/admin/flights/import` | 调度 | 航班查询与批量导入（路径保留 `/admin` 前缀，权限已归调度员） |
| `POST /api/admin/broadcasts` | 调度 | 发布现场情况播报 |
| `POST /api/events` | 调度 | A-OCS 航班事件接入（幂等） |
| `GET /api/driver/tasks`、`POST /api/tasks/{id}/progress` | 司机 | 本人工单查询与进度上报（完成须带 `fuelLevel`） |

## 运行

前提：Python 3.11+、Node.js 20+。后端零第三方依赖；前端可用 npm 或 Yarn 安装依赖。

```bash
# 终端一：启动后端（零第三方依赖）
cd backend
python -m app.server

# 终端二：启动 React 调度台
cd frontend
npm install        # 或 corepack yarn install
npm run dev        # 或 npm start，默认 http://localhost:3000
```

打开前端地址后，使用演示账号登录。以调度员身份点击“生成调度方案”即可为待保障航班分配合格车辆；可导入航班数据、发布播报、微调工单；再登录司机账号模拟开始 / 完成（提交当前油量）/ 异常上报，回到调度台查看态势与告警闭环。

默认数据库是 `backend/dispatch.db`，首次启动会写入演示数据。要重置演示环境，停止服务后删除该单一文件再启动即可。

## A-OCS 事件示例

```json
POST /api/events
{
  "eventId": "aocs-20260914-0001",
  "flightId": "f1",
  "type": "ARRIVED"
}
```

合法 `type`：`ARRIVED`、`DELAYED`、`CANCELLED`、`DEPARTING`。返回中包含本次增量调度结果和最新态势数据。

## 生产演进建议

当前 `Scheduler` 保持了清晰的替换边界，适合在真实机坪数据接入后迁移到 OR-Tools 的 VRPTW 模型：将时间窗、加油量、车辆容积、车辆故障、行驶时间矩阵及人工锁定作为约束，设置短时间上限生成近优解。`backend/requirements-production.txt` 列出了 FastAPI、Uvicorn 与 OR-Tools 的生产依赖建议；演示服务选择标准库，以保证下载即能运行。

部署前还应补充真实鉴权与角色权限、HTTPS、消息队列与失败重试、审计日志、设备离线缓存、监控告警，以及对接真实 A-OCS 的协议适配器。

## 开源复用与许可证

前端基于 [Mantis Free React Material UI Dashboard Template](https://github.com/codedthemes/mantis-free-react-admin-template) 的 Vite 结构、主题与通用布局进行二次开发；该项目为 MIT License，原许可证保留在 `frontend/LICENSE`。

生产调度建议采用 [Google OR-Tools](https://github.com/google/or-tools) 的车辆路径求解能力（Apache-2.0）；本原型的 `Scheduler` 接口已为此预留替换位置。没有直接复制 OR-Tools 代码。
