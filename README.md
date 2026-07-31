<p align="center">
  <img src="docs/logo/openwa_logo.webp" alt="FloorLingo Logo" width="200"/>
</p>

<h1 align="center">FloorLingo</h1>
<p align="center">
  <strong>工廠現場的中越（zh ↔ vi）即時翻譯與詞彙治理，架在自架的 WhatsApp Gateway 上</strong>
</p>

> **這是 [rmyndharis/OpenWA](https://github.com/rmyndharis/OpenWA) 的 fork。**
> 完整的產品說明、功能清單與版本發佈請看上游專案：
> [📖 上游 README](https://github.com/rmyndharis/OpenWA/blob/main/README.md) ·
> [ℹ️ About](https://github.com/rmyndharis/OpenWA) ·
> [🏷️ Releases](https://github.com/rmyndharis/OpenWA/releases)
>
> 本 README **只記錄 FloorLingo 在上游之上新增的變更。**

---

## FloorLingo 新增了什麼

### 中越自動翻譯（zh ↔ vi）
- **自動翻譯外掛**：只對選定的 WhatsApp 群組翻譯訊息（繁體中文 ↔ 越南文）。
- **翻譯設定管理 UI** 加上 runtime API，不需重啟即可開關與調整翻譯設定。
- **LLM 逾時依 provider 而定**：翻譯是序列化在單一佇列後面，所以某個供應商變慢時，**每一則排隊訊息**都要付完整逾時才會切備援，延遲會逐則累積（實測 gemini-flash-lite 從 0.7 秒劣化到 388 秒，持續約 10 分鐘）。因此雲端供應商預設 **8 秒**；自架 Ollama 載入冷模型本來就要數十秒，預設 **30 秒**。`TRANSLATE_LLM_TIMEOUT_MS` 可覆寫兩者（設 0 或非數值則回退預設）。另有斷路器：同一模型連續失敗 2 次後跳閘 60 秒，全部跳閘時仍會全試一遍而非丟棄翻譯。
- 聊天列表的 **翻譯群組篩選**，方便快速找到已翻譯的群組。

### 儀表板變更
- 側邊欄導覽整併進 **Settings**。
- 儀表板 i18n 新增 **越南文（vi）** 語系。
- 聊天捲動修正：捲動位置錨定在最後看到的訊息，另加 **回到底部** 按鈕。
- 修復 icon-row 頁尾的外觀／語言彈窗版面。
- **群組發話者標籤**：群組訊息以 WhatsApp 風格顯示發話者名稱（每位發話者固定配色）。
- **@mention 名稱解析**：把 `@<號碼>` 提及轉成聯絡人顯示名稱（已存名稱 → verifiedName → pushName）。
- **發送者對照表（sender directory）**：名稱解析查不到時（聯絡人未存、無 pushName），翻譯訊息會漏出原始 `@<號碼>`。可手動維護 JID → 顯示名稱 覆蓋表補上，翻譯前自動替換。維護方式：
  - WhatsApp 指令（限 `TRANSLATE_ADMIN_IDS` 名單）：
    - `/sender`：列出所有對照
    - `/sender add <JID或@號碼> = <名稱>`：新增／覆蓋，例 `/sender add 200859128434777 = 總經理`
    - `/sender del <JID或@號碼>`：移除
  - 儀表板「發送者」頁，或 REST `GET/POST/DELETE /translate/senders`（ADMIN）。
  - 儲存於 `data/senders.json`（可用 `TRANSLATE_SENDERS_PATH` 覆寫）。
- **語音訊息翻譯**：語音訊息沒有文字內容，原本會被翻譯直接略過。設定 STT 端點後，語音會先轉成文字再走一般翻譯流程（詞彙表／發送者對照／`/bad` 回饋皆適用），機器人回覆會同時附上轉錄原文與譯文。設定 `TRANSLATE_VOICE_STT_URL` 即啟用：

  | 環境變數 | 預設 | 說明 |
  | --- | --- | --- |
  | `TRANSLATE_VOICE_STT_URL` | （空＝停用） | OpenAI 相容的語音轉文字服務，例 `https://api.groq.com/openai` 或自架 `http://speaches:8000` |
  | `TRANSLATE_VOICE_STT_KEY` | （空） | Bearer 金鑰；自架服務可留空 |
  | `TRANSLATE_VOICE_MODEL` | `whisper-large-v3-turbo` | 自架 faster-whisper 請改成 `small` 等本地模型名 |
  | `TRANSLATE_VOICE_LANGUAGE` | （空＝自動偵測） | BCP-47 語言提示，例 `vi` |
  | `TRANSLATE_VOICE_PROMPT` | （空，**建議維持**） | 詞彙偏置清單（逗號分隔）。詳見下方警告 |
  | `TRANSLATE_VOICE_CONFUSIONS` | （空） | 已知誤聽對照，格式 `bot=boss,Bob,bioti; file=phai`。詳見下方說明 |
  | `TRANSLATE_VOICE_MAX_PER_HOUR` | `60` | 每個聊天每小時轉錄上限（成本護欄） |
  | `TRANSLATE_VOICE_CONCURRENCY` | `2` | 同時進行的轉錄數。自架 CPU whisper 建議 `1`；雲端服務可調高 |
  | `TRANSLATE_VOICE_MAX_BYTES` | `16777216` | 單則語音大小上限 |
  | `TRANSLATE_VOICE_TIMEOUT_MS` | `30000` | 單次轉錄逾時 |
  | `TRANSLATE_VOICE_INCLUDE_AUDIO` | `false` | 設 `true` 連音訊檔（非語音留言）也轉錄，成本較高 |

  注意：`llm-key-proxy` **不能**用於此處——它只代理 `/v1/chat/completions`、`/v1/messages`、`/v1/embeddings`，沒有 `/v1/audio/transcriptions`。語音需直連 Groq／OpenAI 或自架服務。

  **`TRANSLATE_VOICE_PROMPT` 請謹慎使用。** whisper 的 prompt 不是詞彙白名單，而是被當成「前文脈絡」餵給解碼器。填一串逗號分隔的詞是不自然的前文，會提高模型飄進訓練資料罐頭句的機率。實測觀察到的失敗樣態：填入詞表後，數則短音檔被轉成 `Hãy đăng ký kênh để ủng hộ kênh...`（YouTube 字幕的「請訂閱頻道」罐頭句），與實際內容完全無關。清單裡的詞確實會被優先採用，但代價是整句可能飄掉。預設留空。

  **短音檔（3–6 秒）是 whisper 最脆弱的場景**，上下文不足時它傾向用高頻訓練句填補。每次轉錄的日誌都會附上模型自身的信心值，可用來判斷該則是否可疑：

  ```
  Voice transcribed in 402ms (15124B -> 63 chars) no_speech=0.021 logprob=-0.284 seg=2 chat=...: <文字>
  ```

  `no_speech` 偏高代表模型認為該段其實沒人說話，`logprob` 偏低代表輸出信心不足——幻覺片段通常至少命中其一。目前這兩個數值**只記錄不過濾**，門檻需由實際流量累積後再訂。

  **`TRANSLATE_VOICE_CONFUSIONS`：已知誤聽的事後校正。** 越南語者唸英文借詞被辨識成別的英文字時，產生的往往是**通順的句子**（`Con Boss, tôi nói về tốc độ...` 讀起來完全合理），所以既測不出低信心、也看不出語意矛盾。實測顯示泛用指令（「若某字不合語意請重新解讀」）修正率 0/2，而明確列出對照後為 2/3。

  格式 `intended=heard1,heard2; intended2=heard3`，例：

  ```bash
  TRANSLATE_VOICE_CONFUSIONS=bot=boss,Bob,bioti,bót
  ```

  此區塊只在**語音來源**的翻譯提示中注入，打字訊息不受影響（避免給模型改寫已正確文字的許可）。留空則完全不注入。

  兩個限制：只對清單內的誤聽有效，未知的辨識錯誤（如 `bioti`）仍會原樣通過；且允許模型重新解讀有代價——實測曾出現修好 `bot` 的同時把 `tốc độ`（速度）誤譯為「大小」。若附帶損傷頻繁，應退回不做校正，改在轉錄層處理。

### 更名
- 專案 **OpenWA → OpenWA-Lab → FloorLingo**。
- FloorLingo 一輪只換品牌面（套件名、README、compose 標題）。docker 容器名、`openwa-lab-network`、`openwa_*` volume 與 `com.openwa-lab.*` label 一律不動——這些字串在 `src/modules/docker/*` 被逐字比對，改了會孤兒化既有 volume 並打斷編排。

---

## 快速開始

與上游相同——完整設定請見 [上游 README](https://github.com/rmyndharis/OpenWA/blob/main/README.md)。複製 FloorLingo：

```bash
git clone https://github.com/JaplinChen/FloorLingo.git
cd FloorLingo
docker compose -f docker-compose.dev.yml up -d
# 儀表板: http://localhost:2785   API: http://localhost:2785/api   Swagger: http://localhost:2785/api/docs
```

---

## 授權

MIT——沿用上游。詳見 [LICENSE](./LICENSE)。

<div align="center">
<sub>Fork by <a href="https://github.com/JaplinChen">Japlin Chen</a> · 基於 <a href="https://github.com/rmyndharis">Yudhi Armyndharis</a> 的 <a href="https://github.com/rmyndharis/OpenWA">OpenWA</a></sub>
</div>
