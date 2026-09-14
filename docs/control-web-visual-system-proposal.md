# Control Web × Virtual Office 視覺一致性設計稿參考

狀態：第一版已實作（2026-09-14）；此文件保留作為 UI 規格參考
目標：讓 Virtual Office 以外的頁面共享同一套空間感、狀態語言與操作節奏，同時保留管理頁需要的資訊密度與可驗證性。

## 1. 設計方向

Virtual Office 的核心語言不是把每頁都做成 3D，而是：

- 深色工作室頁首搭配暖米白工作區，讓工作狀態成為視覺焦點。
- 頁首固定顯示目前空間、連線狀態與主要動作。
- 所有狀態都以「標籤 + 顏色 + 明確文字」呈現，不靠動畫猜測。
- 先看摘要，再看列表，最後進入右側／下方詳情。
- 將「目前狀態、歷史事件、成果、外部交付」分區，不混成一張漂亮但不可判讀的卡片。

Virtual Office 保留 3D 作為團隊視圖；其他頁面採「工作室控制台」平面化呈現，使用相同的材質、圓角、狀態色與 inspector 思維。

## 2. 全站 Shell

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ P  PERSONAL AI / CONTROL PLANE       工作總覽  辦公室  交辦  任務 ...   ● 已連線 │
├─────────────────────────────────────────────────────────────────────────────┤
│ 麵包屑 / 頁面 eyebrow                                      ＋ 主要動作        │
│ 頁面標題                    一句說明與資料時間                              │
│                                                                             │
│ [摘要卡] [摘要卡] [摘要卡] [摘要卡]                                         │
│                                                                             │
│ 主要內容區（列表／時間線／表格）                         Inspector / 篩選區 │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ 最近動態： 14:32 任務完成 · 14:29 Worker 上線 · 14:20 等待你確認             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Shell 規則

- 不使用傳統厚重 sidebar；沿用 Virtual Office 的深色橫向導覽，當前頁以綠色區塊標示。
- 每頁 header 右上只放一個 primary action，其餘動作降為 quiet／secondary。
- 顯示「已連線／同步中斷／資料待同步」；不可用健康狀態代替任務完成證據。
- 桌面版採 12 欄 grid；列表頁 8 欄 + 4 欄 inspector，細節頁可全寬。
- 手機版轉為單欄，inspector 改為下方 drawer／accordion。

## 3. 視覺 Token

| 類別 | 建議值 | 用法 |
|---|---|---|
| 背景 | `#f2f1eb` | 工作區底色 |
| 卡片 | `#faf9f4` | 卡片、表格、表單 |
| 頁首 | `#18292b` | 全站工作室頁首 |
| 主色 | `#365848` | 主要 CTA、選取 |
| 連結 | `#396555` | 詳情與導覽連結 |
| 警告 | `#f3e6c8` / `#896a3c` | 等待、待確認、未知 |
| 危險 | `#f1e1d5` / `#915c44` | 失敗、離線、取消 |
| 完成 | `#e7ede2` / `#5f8065` | 成功、可用、已交付 |
| 文字 | `#273d38` / `#7c847b` | 標題／輔助文字 |
| 邊框 | `#dcded3` | 卡片、表格、輸入框 |
| 圓角 | `8px` 卡片、`5px` 控件 | 柔和且保持工具感 |

狀態顏色必須與 `Status`／Virtual Office badge 共用，不另為單頁創造顏色。

## 4. 各頁設計稿

### 工作總覽 `/`

```text
今天的控制台                         [＋ 交辦工作]
Hermes 正在協調團隊；以下是有證據的目前狀態

[Hermes ● 已連線] [ContextHub ● 已連線] [執行中 3] [24h 完成 12]

┌ 團隊現況 ─────────────────────────┐  ┌ 需要你處理 ───────────────┐
│ 小型成員 chip + 狀態 + 目前工作     │  │ 2 件待確認                  │
│ [Hermes] [GoosePC] [Mac Worker]     │  │ · 交辦 A 等待資料           │
│                                    │  │ · 任務 B 交付回執未知       │
│ [開啟 Virtual Office →]            │  │ [查看待處理 →]              │
└────────────────────────────────────┘  └────────────────────────────┘

最近活動 timeline                         最近成果 cards
```

### Missions `/missions`

以「交辦看板」取代一般資料表：四個 bucket 對應 Office 的工作看板、成果櫃、待處理。

```text
交辦                                      [＋ 新增交辦]
[全部] [待辦 4] [進行中 2] [待處理 1] [已完成 8]       [搜尋]

┌ 待辦 ──────┐ ┌ 進行中 ────┐ ┌ 待處理 ────┐ ┌ 已完成 ────┐
│ Mission卡  │ │ Mission卡 │ │ Mission卡 │ │ Mission卡 │
│ phase badge│ │ 活動 Worker│ │ 等待原因  │ │ 成果可用  │
└────────────┘ └───────────┘ └───────────┘ └───────────┘
```

### Tasks `/tasks`

保留表格的密度，但套用 Office 卡片與狀態語言。左側是任務列表，右側 inspector 顯示選中任務摘要、目前輪次與下一步。第一版已接上目前 API 的選取任務摘要。

### Task detail `/tasks/:id`

```text
任務標題                         [狀態 badge] [取消／重新執行]
┌ 摘要 ───────────────────┐ ┌ 目前執行 ─────────────────┐
│ instruction / source     │ │ Worker、runtime、model    │
│ priority / created       │ │ Run 2 · Attempt 1/2       │
└─────────────────────────┘ └───────────────────────────┘
成果與外部交付（分開）                         事件時間線
```

### Workers `/workers`

使用「團隊成員卡」而非純表格：頭像／平台圖示、Online badge、接案模式、目前槽位；上方保留 Online／Needs attention／Drained／Pending enrollment 四張摘要卡。點卡片後進入既有詳情與設定操作。

### Models `/models`

以「模型庫」語言呈現：第一版保留模型清單的表格密度，套用暖色卡片、狀態 badge 與比較工具；右側模型偏好仍保留在清單下方。不要把 provider 連線成功渲染成模型推理成功。

### Systems `/systems`

以「系統房間」呈現：Hermes、ContextHub、Control Plane 各一張設備卡，顯示 endpoint、最後觀測時間、health／readiness／capability 三層證據。故障卡提供查看事件，不只顯示紅色健康燈。

### Skills、Goals、Routines

三頁共用「資產卡片 + 右側詳情」版型：

- Skills：能力標籤、觸發方式、最近使用、啟用狀態。
- Goals：目標進度、下一個可執行步驟、關聯 Mission。
- Routines：排程、下次執行、最近一次結果與失敗原因。

這三頁使用相同的空狀態插畫語彙與 primary action，避免每頁重新發明表單。

### Attention `/attention`

直接沿用 Office 的「等你處理」 inspector：依阻塞原因分組，卡片上顯示 owner action、截止時間、相關 Mission／Task；操作完成後要顯示實際 receipt 或狀態更新，不以按鈕動畫表示完成。

### Settings `/settings`

採「控制室」雙欄：左側設定分類，右側表單；每個設定群組都顯示 effective value、來源、版本、最後套用時間。儲存後顯示 revision／套用結果，未知值不可默認成 0。

## 5. 共用元件清單

1. `WorkspaceHeader`：eyebrow、標題、說明、connection、primary action。
2. `MetricCard`：數值、觀測範圍、最後更新時間。
3. `StateBadge`：狀態文字、顏色、可選 stale 樣式。
4. `MemberChip`：沿用 Office 團隊 strip。
5. `InspectorPanel`：標題、摘要、facts、相關連結、操作。
6. `EvidenceRow`：證據類型、值、時間、來源；區分 health／execution／delivery。
7. `ActivityTimeline`：事件名稱、時間、payload 摘要與詳情連結。
8. `EmptyState`：一句話說明、原因、唯一主要動作。

## 6. 第一版實作範圍

本次先完成不改資料契約的視覺層：

1. 全站 shell、token、狀態 badge、metric card、inspector 已統一至 `apps/control-web/src/styles.css`。
2. 工作總覽已改為團隊／待處理／最近成果版型。
3. Missions 已改為四欄看板；Tasks 已加入列表／詳情 inspector。
4. Workers、Models、Systems、Settings、Skills、Goals、Routines、Attention 共用同一套卡片、表格、表單與空狀態樣式。
5. 已完成 desktop、窄螢幕、API 空資料、錯誤／載入狀態與 Virtual Office 回歸檢查。

本稿刻意不指定 3D 場景複製到其他頁面；一致性應來自資訊架構與視覺系統，而不是讓管理表格變成裝飾性場景。
