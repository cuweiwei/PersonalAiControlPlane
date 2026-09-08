# 沉浸式 Virtual Office UI

2026-09-08；狀態：`implemented_local`。本次改動為 Office 顯示與唯讀狀態投影，並未部署至 NAS，也不構成 Mission/provider 全流程驗收。

## 操作與視覺

`/office` 使用可旋轉、縮放及聚焦的 3D 辦公室：Hermes 主管席、木質工作桌與人體關節角色、玻璃隔間、會議桌、咖啡設備、交辦箱、任務看板、文件櫃、印表機、待處理托盤及依本機時間顯示的時鐘。

- 點選人物／工作席：右側顯示職責、執行狀態、目前交辦、步驟、實際 Worker、runtime／model、活動執行數。任務、交辦與成員設定沿用既有路由。
- 點看板：查看目前交辦列表與分類。計數包含所有未封存交辦的目前 run，不受原頁面最近 12 筆清單限制；只顯示前三張紙卡的實體看板不是總數來源。
- 點成果櫃：列出有已套用 finalization 結果的交辦，進入既有詳情查看成果。成果存在和外部交付成功分開呈現。
- 點待處理托盤／「等你處理」：查看等待 owner、暫停、失敗或交付待確認的交辦。
- 點交辦箱：開啟既有交辦表單。人物走動及座位不改派工或權限。
- 每組座位容納五位員工與一位主管；超過時提供座位分頁，完整成員列可直接切換到對應頁。
- 可切換日／夜光線、暫停動畫與簡潔檢視。尊重 `prefers-reduced-motion`，背景分頁停止繪圖；沒有活動角色時只因資料／視角／時鐘變更重繪。

人物採程式建立的成人比例關節模型，環境材質與光照為即時 3D 美術。這是已可互動的實作，不是概念圖的照片級人物／材質細節；人物姿態與螢幕圖樣是視覺比喻，不是即時畫面擷取或隱藏推理展示。

## 本次細節補強

- 家具：圓角桌板、木紋與布料紋理、椅背支架、接觸陰影、螢幕背板與線材、筆記本、筆筒、耳機、白板筆與板擦；窗外城市景色也在本機生成。
- 人物：固定身分對應外觀，補上眼睛、眉毛、髮型、眼鏡、名牌、手指、手錶與鞋子；加入眨眼、呼吸、間歇喝咖啡及翻閱文件。
- 動線：依路徑實際距離前進、沿原路返回座位、平順轉身與切換姿態；待確認或失聯時停止移動。交付走到櫃前不構成交付成功證據。
- 視角：新增低角度「室內」視角及設備「走近查看」，聚焦時平滑移動相機；日夜切換同步調整窗景與桌燈。減少動態效果設定會停用相機過渡。

新增 `test/office-motion.test.ts`，驗證不同長度路段的等速前進與原路返回、零長度路段、最短轉向及穩定外觀種子。瀏覽器已檢查室內視角、日夜切換與看板近景，未出現 console error／warning。本次仍為本機實作，未部署。

## 真實狀態如何驅動畫面

`GET /api/v2/offices/:id` 新增 additive `scene` 欄位；原有欄位保留。投影只讀取目前 Mission Run、active Plan、current execution 與 current Task Attempt，不寫入狀態或產生工作事件。

| 狀態 | 證據與畫面 |
| --- | --- |
| 閒置可接案 | Worker 心跳有效、接案及能力／模型條件可用；員工在座位休息。最終 admission 仍以排程器判定。 |
| 工作中 | Task 與 current Attempt 同為 RUNNING 且 Worker 未失聯，或 Hermes 回報 RUNNING 且目前 brain attempt 有效；打字與閱讀動作。 |
| 規劃中 | 主管的 `plan.requested` 已回報 RUNNING；在主管桌規劃。transport ACK／ADMITTED 不觸發。 |
| 審查中 | 正在執行 REVIEW 的 Hermes step 或 `mission.finalize`；翻閱成果的姿態。 |
| 交付中 | `mission.deliver` 正在 IN_FLIGHT 或有效執行；主管沿通道走往成果櫃後等待。尚無 receipt 時不宣稱交付成功。 |
| 等待中 | 尚未派工、僅 ASSIGNED／ACCEPTED、依賴未齊、能力或模型不符、暫停接案、成果等待流程套用；停止打字。 |
| 離線 | 無 Hermes 設定，或 Worker 離線／心跳過期；空座位與熄暗螢幕。設定 Hermes URL 本身不證明它在線／閒置。 |
| 需要處理／待確認 | 失敗、transport attention、uncertain delivery、過期／失聯 execution 或 recovery；不持續表演忙碌。 |

目前 Worker 子步驟沒有獨立的「交付中」回報，因此不以 Worker task SUCCEEDED 假造上傳動畫；該階段顯示「成果已產生，等待流程套用」。可證明的外部交付動畫目前由主管呈現。

頁面沿用全域 SSE 刷新訊號，另每五秒讀取唯讀投影，以涵蓋未發送 SSE 的狀態變更。請求不重疊，離頁會取消；讀取失敗時保留最後快照、顯示中斷提示、凍結人物動作並把角色標示為待同步。

## 示範與本機驗證

「體驗示範」或 `/office?preview=demo` 只載入明確標示的前端示意資料。可按「切換示範狀態」體驗工作、審查、交付、閒置、等待、離線、異常與未知；不會寫入 API、建立 Mission 或觸發 Worker。離開示範回到真實資料。

```bash
npm ci
npm run build:web
PAI_DATA_DIR=$(mktemp -d /tmp/pai-office-ui.XXXXXX) \
PAI_LISTEN_ADDRESS=127.0.0.1 PAI_PORT=9084 \
PAI_OFFICE_ENABLED=true PAI_HERMES_OFFICE_URL= \
npm start
```

開啟 `http://127.0.0.1:9084/office?preview=demo`。此命令使用全新暫存資料庫；停止本機程序不影響 NAS。

檢查：`npm run typecheck`、`npm run build:web`、`npm run check`、`npm test`。`test/office-scene.test.ts` 覆蓋派送不等於執行、心跳／接案限制、Hermes ACK 與進度證據、recovery、完整看板計數、成果與外部交付分離；HTTP 測試也檢查新增 scene contract。本機 48 項測試已通過。瀏覽器已驗證全景、成員詳情、聚焦、動畫開關、日夜光線、設備列表、六位成員的座位分頁、簡潔檢視切換，以及停止／重啟獨立預覽服務後的斷線提示與自動恢復。窄螢幕另以響應式 viewport 檢查。

Three.js 為固定版本的 npm 依賴，Office 才延遲載入 3D chunk。所有場景幾何、材質與標籤本地建立，不依賴外部 CDN、遙測或遠端模型素材。WebGL 無法初始化或 context lost 時切換簡潔檢視；離頁時清除 renderer、controls、observer、timer、geometry、material 與 texture。
