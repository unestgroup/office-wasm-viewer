# Phân tích OnlyOffice x2t-wasm và thiết kế 2 sản phẩm

> **Ghi chú 12/11/2026 — đã tách repo.** Tài liệu này viết khi mọi thứ còn nằm trong một thư mục `office-wasm/`. Nay có ba repo anh em:
> `office-wasm-viewer` (repo này: viewer AGPL, x2t, gói font, build), `office-wasm-sdk` (`sdk/`, `src/extract/`, trang demo `demo/` = cũ `poc/preview/`, mẫu `samples/`, e2e) và `metafile-wasm` (WMF/EMF → SVG/PNG; `src/` = cũ `viewer/metafile/`, `test/` = cũ `poc/metafile/`). Đường dẫn `viewer\…` trong văn bản bên dưới nay là gốc repo này; `poc\preview`, `sdk\`, `src\extract`, `samples\` nằm ở `office-wasm-sdk`.

Ngày 10/11/2026. Mọi số liệu dưới đây đo trên máy này (Node v22.22.3, Chromium 156 headless), file mẫu trong `samples\`.

## 1. Upstream gồm những gì

| Thành phần | Nguồn | Vai trò | Giấy phép |
|---|---|---|---|
| `x2t.js` + `x2t.wasm` (38,4 MB; 6,9 MB brotli) | cryptpad/onlyoffice-x2t-wasm `v9.3.2+4` (core v9.3.2 biên dịch bằng emscripten) | Bộ chuyển định dạng C++ của OnlyOffice | AGPL-3.0 |
| `sdkjs` (171 MB) | cryptpad/onlyoffice-editor `v9.3.2+3` | Engine dàn trang + vẽ canvas (word/cell/slide), tự mang `fonts.wasm` | AGPL-3.0 |
| `web-apps` (607 MB) | cùng gói | Giao diện editor/viewer; `api.js` đã được CryptPad thay bằng bản không cần document server | AGPL-3.0 |
| `fonts/` (95 file, 45 MB), `dictionaries/` (272 MB) | cùng gói | Font mở thay thế; từ điển chính tả (viewer không cần) | nhiều loại |

Điểm vào x2t: `main1(đường_dẫn_params.xml)` gọi qua `ccall`; tham số là XML `TaskQueueDataConvert`; file đọc/ghi trong MEMFS `/working`.

## 2. x2t.wasm làm được gì, không làm được gì

Bản WASM biên dịch `doctrenderer_empty.cpp` (không nhúng JS engine) nên **x2t một mình không dàn trang được**.

| Chuyển đổi | Kết quả | Thời gian |
|---|---|---|
| docx/xlsx/pptx → `Editor.bin` (DOCY/XLSY/PPTY) + `media/` | được | 26–36 ms |
| docx → txt, xlsx → csv, pptx → txt, docx → odt | được | 7–79 ms |
| `Editor.bin` + `pdf.bin` + media + font → PDF | được | 40–87 ms |
| docx/xlsx/pptx → pdf / png / html trực tiếp | **không** (exit 80) | — |

Khởi tạo wasm (bản dựng sẵn; bản tự build ở mục 7): ~90 ms (Node), 180–260 ms (trình duyệt, tính cả tải). Font **không cần** cho `Editor.bin`/văn bản; chỉ cần khi ghi PDF.

## 3. Sản phẩm 1 — xem trước offline (đã chạy được)

```
file ──► x2t.wasm (web worker) ──► Editor.bin + media ──► sdkjs/web-apps trong iframe (type embedded | desktop, mode view)
                                                              ▲ mock server: connectMockServer({getParticipants, getImageURL, onMessage})
```

- `document.url` = blob URL của `Editor.bin`; ảnh trả qua `getImageURL(name)` bằng blob URL. Trang chủ phải có `window.APP = {}` trước khi tạo editor.
- Không có request nào ra ngoài (e2e chặn mọi URL khác `127.0.0.1`, đếm được 0).
- Kết quả e2e 8/8 đạt (4 file × 2 giao diện): mở file → hiển thị xong **551–844 ms**; tải lạnh **13,4–17,4 MB / 49–64 request** (đã nén brotli).
- Lỗi console còn lại đều vô hại: 404 `@@SRC_ROOT@@/...` (placeholder sót trong bản build của CryptPad), `document_editor_service_worker.js`, `themes.json`, icon header.

Mã: thành phần viewer `viewer\` (AGPL, mục 10) — `viewer\viewer.mjs`, `viewer\x2t\{x2t-worker.js, browser-client.mjs, formats.mjs}`; trang demo host `poc\preview\{server.cjs, index.html, app.mjs, e2e.cjs}` dùng `sdk\office-viewer.mjs`. Chạy: `npm run serve` rồi mở http://127.0.0.1:8765/ (viewer ở http://127.0.0.1:8766/).

## 4. Sản phẩm 2 — bộ chuyển đổi

### 4.1 PDF (đã chạy được trong trình duyệt)

```
sdkjs (đã mở tài liệu) ── asc_DownloadAs(PDF) ──► window.APP.printPdf(dataContainer) ──► pdf.bin
pdf.bin + Editor.bin + media + fonts ──► x2t.wasm (formatTo 513) ──► PDF
```

- docx 10 trang: sdkjs 41–67 ms + x2t 52–60 ms; tổng **247–314 ms** (lần đầu gồm ~200 ms nạp 95 font/44,7 MB vào x2t).
- PDF ra: chữ chọn/copy được, font nhúng, ảnh giữ nguyên (đã mở kiểm tra `poc\out\e2e\fonts_and_images.docx.embedded.pdf`).
- Chạy phía server: chính quy trình này điều khiển bằng Chromium headless (`poc\preview\e2e.cjs` là mẫu). **Không có đường thuần Node**: doctrenderer gốc cần ~10 lớp nhúng C++ (GraphicsEmbed ~130 hàm, TextMeasurer, Zip, Hash…); viết lại bằng JS là việc lớn, chưa nên làm.

### 4.2 Trích văn bản + cấu trúc (đã có, thuần JS)

`src\extract\` — không phụ thuộc, không chứa mã OnlyOffice (đặt giấy phép tuỳ ý), chạy Node ≥ 20 / trình duyệt / worker.

| | JS thuần | x2t.wasm |
|---|---|---|
| Thời gian / file mẫu | **0,13–0,45 ms** (trung vị) | 7–79 ms + ~90 ms khởi tạo |
| Dung lượng mã | ~30 KB | 38,4 MB |
| Kết quả | text + cấu trúc JSON | chỉ text / csv |
| Định dạng | docx, xlsx, pptx (và docm/xlsm/pptm…) | thêm doc, xls, ppt, odt, ods, odp, rtf… |

Cấu trúc trả về: docx → `blocks` (heading có level, paragraph, list-item, table, link, header/footer/footnote/comment); xlsx → `sheets[].rows[].cells[]` (giá trị đã định kiểu, ngày ISO, công thức, ô gộp); pptx → `slides[]` (tiêu đề, shape, bảng, ảnh, ghi chú). Độ dài text lệch ~1% so với x2t (do BOM và cách xuống dòng).
File cũ (.doc/.xls/.ppt/.odt/.rtf): `extract()` ném `UnsupportedFormatError` → dùng x2t chuyển sang OOXML rồi trích lại.

## 5. Rủi ro và việc chưa kiểm

1. **AGPL-3.0** cho x2t, sdkjs, web-apps, wrapper CryptPad: xem mục 9. Bộ trích `src\extract` không dính.
2. **Font**: gói chỉ có font mở (Arimo, Tinos, Carlito…) thay cho Arial/Times New Roman/Calibri. sdkjs nguyên bản chọn DejaVu Sans cho "Times New Roman"; đã sửa bằng bảng bí danh (mục 8). Font không có bản thay cùng số đo (Century Gothic…) vẫn lệch. Gói font CryptPad có sẵn `arial.ttf`, `calibri.ttf`: chưa kiểm quyền phân phối. Chưa thử font do người dùng cung cấp.
3. **Dung lượng**: gói đầy đủ 1,1 GB trên đĩa. Viewer chỉ cần `sdkjs` + `web-apps/apps/{api,common,*/embed}` + font; bỏ `dictionaries` (272 MB) và phần editor `main`. Chưa cắt.
4. PDF hiện nạp cả 95 font vào x2t; nên chỉ nạp font tài liệu dùng.
5. Mới thử 5 file nhỏ và 1 đề thi thật (mục 8). Chưa thử file lớn (bảng tính 100k dòng, slide nhiều ảnh), file có mật khẩu, macro, SmartArt, công thức OMML, chữ RTL.
6. Đã tự build từ nguồn (mục 7). Chưa cắt bớt định dạng để giảm dung lượng wasm.
7. Logo "ONLYOFFICE" trong viewer embed: điều khoản bổ sung của giấy phép OnlyOffice yêu cầu giữ logo; cần xem lại nếu muốn đổi thương hiệu.

## 6. Bước tiếp đề xuất

1. Đóng gói viewer thành thư viện (`<office-preview src=…>`), cắt gói tĩnh xuống mức cần cho embed, thêm service worker cache.
2. Bộ chuyển PDF dạng dịch vụ: pool Chromium headless + trang convert tối giản (không UI), nạp font theo nhu cầu.
3. Bộ thử độ trung thực: tập file thật (tiếng Việt, mẫu của trường) → so ảnh trang với bản MS Office/LibreOffice.
4. Bổ sung extractor: gridSpan/vMerge của bảng docx, đánh số list, định dạng số xlsx, đường dẫn x2t cho định dạng cũ.

## 7. Tự build x2t.wasm, hai chế độ

Lệnh: `node build/x2t/build.mjs st|mt` (Docker; chi tiết, giới hạn bộ nhớ và cách cache ở `viewer\build\x2t\README.md`). Nguồn: Dockerfile của CryptPad tại commit `17bd0351`, không sửa repo upstream; phần thay đổi nằm ở `viewer\build\x2t\ctx\`.

| | Bản dựng sẵn CryptPad | `st` (tự build) | `mt` (tự build) |
|---|---|---|---|
| Yêu cầu trang | không | không | COOP `same-origin` + COEP `require-corp` (`crossOriginIsolated`) |
| Cờ | `-Os` | `-O2` | `-O3 -msimd128 -pthread`, bộ nhớ đầu 384 MB (dùng chung) |
| `x2t.wasm` (thô / brotli) | 38,4 / 6,86 MB | 50,5 / 7,79 MB | 51,2 / 7,95 MB |
| Khởi tạo, Node | ~91 ms | ~210 ms | ~236 ms |
| docx/xlsx/pptx mẫu → `Editor.bin`, Node | 34–44 ms | 36–47 ms | 37–48 ms |
| Đề thi thật → `Editor.bin`, Node | **crash** | 214 ms | 212 ms |
| Đề thi thật, trình duyệt: khởi tạo / `Editor.bin` / ghi PDF | crash | 285 / 441–456 / 1127–1199 ms | 299–343 / 479–516 / 1062–1190 ms |

Chọn chế độ: `viewer\x2t\browser-client.mjs` dùng `mt` khi trang `crossOriginIsolated` và có đường dẫn bản `mt`, còn lại dùng `st`. E2E: `npm run e2e` (st) 8/8 đạt, `npm run e2e:coi` (mt) 8/8 đạt; đề thi thật đạt ở cả hai, PDF cùng kích thước và số trang (1.793.275 B, 9 trang).

**Bản `mt` hiện không nhanh hơn `st`.** Mã chuyển đổi của core 9.3.2 không tạo luồng nào: đo với pool 0, 1, 2, 8 luồng cho cùng thời gian; chênh lệch với `st` nằm trong nhiễu đo (phần lợi chỉ đến từ `-O3`/SIMD). Bản `mt` là nền để song song hoá về sau (chỗ đáng làm nhất: raster 169 ảnh WMF khi ghi PDF, hiện 1,1–1,2 s), còn hôm nay nên mặc định `st`. Muốn tăng thông lượng ngay: chạy nhiều worker `st` (mỗi worker một tài liệu), không cần COOP/COEP. Pool mặc định của `mt` đã hạ từ 8 xuống 2 luồng.

Khởi tạo `st` chậm hơn bản dựng sẵn ~120 ms ở Node do `-O2` thay `-Os` (wasm lớn hơn 12 MB); đổi `opt` trong `build.mjs` về `-Os` nếu ưu tiên dung lượng và thời gian tải.

Lỗi đã sửa bằng patch `viewer\build\x2t\ctx\patches\0001-svg-css-calculator-layout.patch`: mọi tài liệu có WMF/EMF/SVG làm x2t.wasm dừng với `memory access out of bounds`. Nguyên nhân: mã SVG của `graphics` biên dịch không có `CSS_CALCULATOR_WITH_XHTML` nhưng link với bản CSS calculator biên dịch có define đó, hai bên hiểu khác nhau về kích thước lớp nên heap bị ghi đè. Bản dựng sẵn của CryptPad vẫn còn lỗi này; nên báo cho CryptPad (chưa gửi).

## 8. Kiểm thử với đề thi thật (`samples\local\de-mau.docx`, không đưa vào git)

File: 600.793 B, 9 trang trong Word, 169 công thức MathType (đối tượng OLE, ảnh xem trước WMF), 6 ảnh PNG, 1 bảng, font Times New Roman + Century Gothic.

| Hạng mục | Kết quả (bản `st` tự build) |
|---|---|
| docx → Editor.bin | exit 0, 214 ms (Node), 249.287 B + 513 file media (169 × svg/wmf/bin + 6 png). **Bản dựng sẵn của CryptPad crash** ở file này (mục 7) |
| Xem trước `embedded` / `desktop` | đạt; hiển thị xong 0,9–1,3 s; tải lạnh 18–19 MB; 0 request ra ngoài; 0 lỗi trang |
| PDF | 1.793.275 B, **9 trang (khớp Word)**, font nhúng Tinos/Arial/Calibri, chữ chọn được, 344 ảnh raster (công thức); tổng ~1,4–1,5 s, trong đó x2t ~1,2 s (vẽ 169 WMF) |
| Trích văn bản | JS: 9.478 ký tự, 155 đoạn, 6 mục danh sách, 1 bảng, 15 ms. x2t: 9.845 ký tự, 59 ms. **Công thức không có chữ** (nằm trong OLE) |

Báo cáo: `poc\out\e2e\report.de-mau.st.json`; ảnh chụp và PDF: `poc\out\e2e\local\`.

Lỗi đã sửa khi thử file này:

1. **Crash x2t với mọi tài liệu có WMF/EMF/SVG** — lỗi của bản build wasm upstream, sửa bằng patch (mục 7).
2. **Công thức trống trong bản xem và mất trong PDF** — x2t đổi WMF thành SVG cho editor; blob URL của ảnh phải có MIME `image/svg+xml` (`mediaMimeOf` trong `viewer\x2t\formats.mjs`).
3. **"Times New Roman" bị vẽ bằng DejaVu Sans** (10 trang thay vì 9) — sdkjs chấm điểm font theo tên/panose và không coi Tinos là bản thay. `viewer\fonts\font-aliases.cjs` thêm tên bí danh vào danh sách font của sdkjs (`AllFonts.js`, trường tên phụ của từng bản ghi); `viewer\tools\serve.cjs` phục vụ file đã thêm (tắt bằng `--no-font-aliases`). Bí danh: Times New Roman/Times/Liberation Serif → Tinos, Courier New/Liberation Mono → Cousine, Helvetica/Liberation Sans → Arimo, Cambria → Caladea.

Còn tồn tại (cần quyết định sản phẩm):

- **Ký hiệu trong công thức MathType phụ thuộc font.** Ảnh công thức chứa chữ với font `MT Extra` (mũi tên vectơ, ℝ, ℕ), `Symbol`, `Euclid Math Two`.
  - Bản xem: SVG trong thẻ ảnh chỉ dùng được font cài trên máy người xem. Máy này (có MT Extra của Office, Symbol) vẽ đúng mũi tên; ℝ/ℕ ra "¡"/"¥". Máy không có các font đó (điện thoại, Mac, Linux) sẽ sai nhiều hơn (suy từ nội dung SVG, chưa thử).
  - PDF: x2t vẽ bằng bộ font nạp vào nó. Không có MT Extra → mũi tên vectơ ra dấu nháy, ℝ/ℕ ra "¡"/"¥". Thử thêm `MTEXTRA.TTF` của Office vào bộ font: mũi tên đúng, ℝ/ℕ thành trống (bản MT Extra kèm Office thiếu các glyph này; bản đầy đủ đi kèm MathType).
  - **Đã xử lý bằng font thay thế mở (mục 11)**: cả bản xem và PDF vẽ đúng mũi tên vectơ, ℝ, ℕ, ngoặc nhọn, mũ rộng trên mọi máy. Việc còn lại nếu muốn có *chữ* công thức khi trích văn bản: đọc MTEF trong OLE `.bin` → MathML/OMML.
- Century Gothic (font theme của style danh sách/bảng) → Arial: không có bản thay cùng số đo trong gói.

## 9. AGPL-3.0: phải công bố những gì

Không phải tư vấn pháp lý; vùng xám cần luật sư xác nhận trước khi thương mại hoá.

- **Không** buộc công bố toàn bộ hệ thống chỉ vì có dùng thư viện. Nghĩa vụ áp vào *chương trình AGPL và tác phẩm dựa trên/kết hợp với nó*; điều 13 thêm: người dùng tương tác qua mạng với bản đã sửa phải được nhận mã nguồn tương ứng của bản đó.
- **Phải công bố (AGPL-3.0):** x2t, sdkjs, web-apps kèm mọi sửa đổi; patch `core`, script build; mã chạy chung một chương trình với chúng — worker/client gọi x2t, trang gọi thẳng API sdkjs, bảng bí danh font ghi vào `AllFonts.js`. Tất cả nay nằm trong `viewer\` (mục 10).
- **Không buộc:** chương trình riêng biệt chỉ trao đổi dữ liệu qua giao diện hẹp — backend, CSDL, ứng dụng web nhúng viewer bằng iframe + `postMessage`/URL, dịch vụ gọi bộ convert qua HTTP. `src\extract` không chứa mã OnlyOffice.
- **Vùng xám:** trang của bạn gọi sâu vào đối tượng JS của sdkjs, hoặc đóng gói (bundle) mã riêng chung một file với sdkjs/x2t → dễ bị coi là một tác phẩm kết hợp.
- **Cách tổ chức (đã làm, mục 10):** tách viewer + converter thành một thành phần độc lập, mã nguồn công khai theo AGPL (repo riêng, có link "Source" trong giao diện), phục vụ ở đường dẫn/origin riêng; phần còn lại của hệ thống chỉ nói chuyện với nó qua iframe + `postMessage` hoặc HTTP.
- **Điều khoản bổ sung của OnlyOffice (mục 7 AGPL):** giữ logo/ghi công trong giao diện, không được dùng nhãn hiệu ONLYOFFICE cho sản phẩm của mình.
- **Lối khác:** mua giấy phép thương mại (mục 12) nếu không muốn công bố thành phần này.

## 10. Tách thành phần viewer + converter (AGPL) khỏi phần còn lại

| Thư mục | Giấy phép | Nội dung |
|---|---|---|
| `viewer\` | AGPL-3.0-or-later (`LICENSE`, `NOTICE.md`, `README.md`) | trang nhúng `index.html` + `viewer.mjs`, `x2t\`, `fonts\` (bí danh, font công thức), `build\x2t\`, `tools\{serve,x2t-smoke,x2t-run}.cjs`; `artifacts\`, `upstream\` (gitignore) |
| `sdk\office-viewer.mjs` | tuỳ chọn (của chủ) | tạo iframe + RPC `postMessage`; không chứa mã viewer |
| `src\extract\` | tuỳ chọn | trích văn bản thuần JS |
| `poc\preview\` | tuỳ chọn | trang demo host + e2e |

- Giao thức: host → `{target:'office-wasm-viewer', id, method, params}`, method `open | exportPdf | convert | close | getState`; viewer → `{source, id, ok, result|error}` và sự kiện `ready | phase | log | editorError | editorWarning | pdf`. Viewer chỉ trả lời `window.parent` đúng origin `?host=` (SDK tự đặt); SDK chỉ nhận tin từ đúng iframe + origin.
- Demo chạy hai origin: host 127.0.0.1:8765, viewer 127.0.0.1:8766 (host tự khởi động server viewer). Viewer gửi `frame-ancestors 'self' <host>` (phải có `'self'` vì editor là iframe con của viewer). `--coi`: host gửi COOP+COEP, viewer gửi COOP+COEP+CORP, iframe có `allow="cross-origin-isolated"` → bản `mt` chạy được trong iframe khác origin.
- Điều 13 AGPL: điền URL mã nguồn vào thẻ `<meta name="office-wasm-viewer:source">` của `viewer\index.html`; viewer báo lại trong sự kiện `ready` để host hiện link "Source".
- Kiểm thử sau khi tách: `npm run e2e` 8/8 đạt (st), `npm run e2e:coi` 8/8 đạt (mt/2 luồng), đề thi thật đạt; `npm run smoke:x2t -- x2t-st` như trước (đường cần dàn trang exit 80 là đúng).
- Chưa công bố lên remote nào. Trước khi công bố: gói font CryptPad có `arial*.ttf` (Monotype) và `calibri*.ttf` (Microsoft) — ghi chú bản quyền trong file không cho phân phối lại.

## 11. Font thay thế cho công thức MathType

Bản quyền: font của MathType (MT Extra bản đầy đủ, Euclid…) theo EULA của Wiris chỉ dùng khi đã cài MathType, không được phân phối riêng/cấp lại/sửa; `MTEXTRA.TTF` của Office chỉ dùng theo giấy phép Office → **không được đưa lên trình duyệt người xem**. Vì vậy tự dựng font thay thế từ STIX Two Math (OFL 1.1, đặt tên khác vì "TM Math" là tên dành riêng):

| Font (`viewer\fonts\math\`) | Thay cho | Số glyph | woff2 |
|---|---|---|---|
| Wasm Math Extra | MT Extra, Euclid Extra | 103 (46 → 103 ở vòng 4) | 7,1 KB |
| Wasm Math Symbol | Symbol, Euclid Symbol | 188 | 13,2 KB |
| Wasm Math Blackboard | Euclid Math Two (chữ hoa + k + quan hệ, tam giác, tập hợp) | 138 | 6,3 KB |
| Wasm Math Script | Euclid Math One | 148 | 11,8 KB |
| Wasm Math Fraktur | Euclid Fraktur | 98 | 10,1 KB |

- Dựng: `npm run build:math-fonts` (`viewer\fonts\math-src\`, fontTools trong venv riêng). Hộp glyph theo số đo font gốc; đối chiếu bằng bảng thử chồng lên MT Extra/Symbol cài trên máy.
- Bản xem (`viewer\fonts\math-compat.mjs`): đổi `font-family` trong SVG do x2t tạo và nhúng woff2 dạng data URI (ảnh `<img>` không dùng được font của trang). Mặc định font thay thế trước (`?mathFonts=embedded`); `installed-first` ưu tiên font cài trên máy người xem; `off` tắt.
- PDF: x2t vẽ từ WMF (không từ SVG) và chọn font theo tên → đổi tên font trong bản ghi `META_CREATEFONTINDIRECT` của WMF và nạp 3 file .ttf vào x2t. Kiểm: 147 WMF của đề thi, 114 có đổi, 0 lỗi (bản ghi chữ và mã ký tự giữ nguyên).
- Kết quả đề thi: trước — mũi tên vectơ thành dấu nháy, ℝ/ℕ thành "¡"/"¥"; sau — mũi tên, ℝ, ℕ, ngoặc nhọn, mũi tên dài trên `AB` đúng ở cả bản xem và PDF; PDF vẫn 9 trang, thời gian như cũ (+3 font, +0,1 MB).
- Giới hạn còn lại: nét ngoặc ghép (0xE6–0xFE) đậm hơn Symbol gốc một chút; các mảnh co giãn của MT Extra không vẽ (xem mục 13).

## 12. Giá giấy phép thương mại (tham khảo, 11/2026)

| Gói | Giá công bố | Ghi chú |
|---|---|---|
| ONLYOFFICE Docs Developer Edition | chỉ báo giá, từ 250 kết nối | đại lý ComponentSource (lấy từ trích đoạn tìm kiếm, trang chặn truy cập): Single Server 250 kết nối 1 năm ~$8.918; máy dev 20 kết nối ~$1.911; White Label tính thêm |
| ONLYOFFICE Docs Enterprise | từ $33/kết nối/năm (từ 50 kết nối) | có gói trọn đời + 3 năm cập nhật; không White Label; cho dùng nội bộ |
| Home Server | $149/máy/năm | dùng cá nhân |

- Giấy phép Developer cấp cho *server Docs*; dùng x2t/sdkjs dạng wasm trong trình duyệt là mô hình khác → phải đàm phán riêng với Ascensio.
- Giấy phép Ascensio **không** bao phần CryptPad (XWiki) đã sửa trong sdkjs/web-apps/x2t-wasm (AGPL) — muốn đóng mã phải dựng lại từ nguồn OnlyOffice gốc hoặc thoả thuận thêm với XWiki.
- Kết luận: với cách tách ở mục 10, công bố `viewer\` theo AGPL rẻ hơn nhiều; chỉ mua khi cần đóng mã viewer hoặc bỏ logo.

## 13. Vòng 4 (10/11/2026): bản quyền Arial/Calibri, bảng mã Euclid, công thức EMF

### 13.1 Vì sao thư viện upstream dùng được arial*/calibri*

- Trong `cryptpad/onlyoffice-x2t-wasm`, `arial*.ttf`/`calibri*.ttf` nằm ở `tests/fonts/` (commit c2d8d703, 10/08/2023): **file phục vụ kiểm thử**, không có giấy phép phân phối. Kho `ONLYOFFICE/core-fonts` không có Arial/Calibri; Document Server dùng bản có sẵn trên máy chủ (Windows/Office), không kèm theo.
- Arial 2.82: giấy phép "Core Fonts for the Web" (Monotype/Microsoft) chỉ cho phép chép **nguyên bản đầy đủ kèm EULA**, không lợi nhuận, không là một phần sản phẩm của mình, không tạo bản dẫn xuất (trừ subset để nhúng vào tài liệu); name ID 13 của font nói không chép/phân phối. Calibri 1.02: bản quyền Microsoft, `fsType` 8, chỉ dùng theo giấy phép sản phẩm Microsoft, nhúng vào nội dung.
- Kết luận: upstream "dùng được" chỉ vì là fixture trong repo test, không phải có quyền phân phối → với sản phẩm công bố là **rủi ro**. Khuyến nghị: bỏ 8 file khỏi gói triển khai; ánh xạ Arial → Arimo, Calibri → Carlito (đã có trong gói, cùng số đo). *Chưa xoá* (cần chủ đồng ý: đổi gói font + `AllFonts.js` + chạy lại e2e).

### 13.2 Bảng mã Euclid đáng tin cậy

Bảng chính thức của Design Science (trang "MathType character encodings": eumat1, eumat2, eufrak, mtextra, symbol; đọc qua web.archive.org) cho mỗi mã byte → MTCode (Unicode hoặc vùng PUA của MathType) + mô tả. Đã lưu thành dữ liệu ở `vieweronts\math-src\encodings\design-science.json`. Dựng font theo bảng (`build-math-fonts.py`): MTCode Unicode → glyph STIX cùng ký tự; F0xx/F1xx (blackboard/script/Fraktur) → chữ toán học 1D4xx–1D5xx; PUA khác chỉ ánh xạ khi cùng nghĩa (`PUA_ANALOG`); không có thì bỏ, ghi `uncovered` trong `math-fonts.json`. Kiểm bằng `proof.cjs` (glyph + mô tả của bảng); Symbol đối chiếu với bảng: 163/189 trùng, phần còn lại là mảnh ngoặc/co giãn (PUA ↔ Unicode) và hai ký tự tương đương (`suchthat`, `lozenge`).

Chưa vẽ (mảnh co giãn/trang trí, không có tương đương Unicode): MT Extra `35 45–48 69 6A 7C 7E 81 82 84 85 A7–AE B0–B2 B6 B7 BA–BC C0–C3 D1–D3 D5 D6 E7`; Math One `80 F6`.

### 13.3 Công thức EMF

x2t đã tự đổi EMF thành SVG (bản xem) và tự vẽ EMF khi tạo PDF; chỉ thiếu font. Thêm `renameEmfFonts` (`vieweronts\math-compat.mjs`): ghi đè tên font trong bản ghi `EMR_EXTCREATEFONTINDIRECTW` (LOGFONTW, 32 WCHAR, đúng chỗ nên kích thước file không đổi) và nối vào `buildPdf` cho `.emf`. Bản xem dùng chung đường SVG đã có. Kiểm bằng `samples\emf-math.docx` (EMF GDI có mảng dx như MathType, chữ MT Extra/Symbol/Euclid×3): bản xem và PDF vẽ đúng ký hiệu; đối chứng `--math-fonts off` ra chữ Latin thường (A, r, V, W, ¶ …). EMF+ (GDI+) và EMZ (nén) chưa xử lý.

### 13.4 EMF+ (GDI+) và EMZ (nén) — 10/11/2026

- **EMF+**: tên họ font nằm trong bản ghi `EmfPlusObject` loại Font (ObjectType = 6; 1 brush, 2 pen, 3 path, 4 region, 5 image, 6 font, 7 string format) bên trong `EMR_COMMENT` mở đầu bằng "EMF+". GDI+ ghi tên IN HOA (`MT EXTRA`, `SYMBOL`); bảng FACES so không phân biệt hoa/thường. Tên mới dài hơn tên cũ nên `renameEmfPlusFonts` dựng lại bản ghi font, bản ghi comment và `nBytes` trong EMR_HEADER (phần EMR_EXTCREATEFONTINDIRECTW của EMF "dual" vẫn ghi đè tại chỗ). Mẫu: `samples/emfplus-math.docx` (EMF+ viết tay, 5 font), `samples/gdiplus-EmfPlusOnly.docx` (System.Drawing thật). x2t vẽ EMF+ vào PDF dưới dạng ảnh nhưng vẫn chọn font theo tên → có đổi tên thì ra công thức, đối chứng `--math-fonts off` ra chữ thường. Lưu ý: với EMF+ x2t tự dàn chữ (không có mảng dx như MathType) nên khoảng cách có thể lệch nhẹ (thấy ở hàng Symbol: "≤≥" sát nhau).
- **EMZ/WMZ**: x2t không nhận định dạng này; mở docx có `.emz` là abort `missing function: heif_context_alloc`. `x2t/prepare-package.mjs` giải nén gzip trong gói OOXML, lưu thành `.emf/.wmf`, sửa `.rels` và `[Content_Types].xml`, chép nguyên các phần còn lại (không đụng dữ liệu đã nén); gói Zip64/mã hoá/hỏng thì trả lại nguyên. Chạy trước x2t trong `openDocument`, sau đó đường đổi tên font như EMF thường. Mẫu: `samples/emz-math.docx`, `samples/gdiplus-emz.docx`.

## 14. Gói font (10/11/2026)

- `tools/font-pack.cjs [--vn original|open] [--check]` (idempotent): xoá arial*/calibri*, chép `.VnTime/.VnTimeH`, viết lại `AllFonts.js` (`fonts/font-pack.cjs`: removeFonts/addFonts). Bí danh: Arial→Arimo, Calibri→Carlito, Times New Roman→Tinos (Times New Roman thật là của Monotype/Microsoft, không phân phối được).
- `.VnTime/.VnTimeH`: bản gốc ABC lấy từ trang Hồ Ngọc Đức (Internet Archive 2020, `abcwin.zip`, `vnsfont2.zip`, `vnsfont3.zip`), không có giấy phép đi kèm; bộ thay thế OFL dựng từ Tinos (`fonts/vn/`). Mặc định cài bản gốc theo yêu cầu của chủ; đổi bằng `--vn open`. Bản gốc thiếu glyph: `VHTIME` (byte B7), `VHTIMEBI` (A4–A6).
- Chữ ư: byte 0xAD trong văn bản TCVN3 là U+00AD (dấu nối mềm) nên trình soạn thảo ẩn ("Trường" hiện "Trờng"). Đã sửa (10/11): `prepare-package.mjs` đổi U+00AD → U+F0AD trong các run dùng font `.Vn*` (kể cả chạy theo style / docDefaults; pptx theo `a:latin`) trước khi vào x2t; font gói có thêm mã U+F0AD trỏ cùng glyph (`fonts/vn/` đã có sẵn kiểu U+F000+byte; bản gốc dùng `fonts/vn-src/patch-vn-originals.py` → `fonts/vn-orig/patched/`, bản gốc nguyên vẹn giữ ở `fonts/vn-orig/`). Khi lưu ở chế độ edit, `preparePackage(…, {restore:true})` đổi ngược U+F0AD → U+00AD để file ra đúng như Word/font thật mong đợi.
- **Quyết định của chủ (10/11): VnTime do nhà nước ban hành → dùng bản gốc, không cần lo bản quyền; chỉ dùng bản open nếu tốt hơn, so sánh tương đương.** Đo 8 file (phủ glyph, độ rộng, metrics dòng): phủ glyph TCVN3 + dấu câu — gốc vá 100%, open 100%; độ rộng (ASCII + 134 mã TCVN3) lệch trung bình 0,3–1% em, tối đa 7% (Italic có một glyph lệch 0,61 em); **metrics dòng** gốc ascent/descent ≈ 1397/−464 trên 2048, open (kế thừa Tinos) 1825/−443 → dòng cao hơn ~20%, trang dàn khác. Kết luận: bản gốc vá ≥ open ở mọi tiêu chí (giữ đúng dàn trang tài liệu cũ) nên mặc định `--vn original`; open chỉ là dự phòng.
- Glyph thiếu của bản gốc đã bổ sung từ bản OFL (cùng em): chữ TCVN3 (`VHTIME` B7, `VHTIMEBI` A4–A6) và dấu câu Word tự chèn (– — ‘ ’ “ ” • … €), vì thiếu thì trình soạn thảo vẽ khoảng trống (mất dấu gạch dài, "dính chữ").

## 15. Chế độ chỉnh sửa (edit) — 10/11/2026

- Vì sao desktop chưa sửa được: cấu hình cứng `mode: 'view'`, `permissions.edit: false`, và máy chủ giả chỉ trả lời mở tài liệu, bỏ qua `isSaveLock` / `getLock` / `saveChanges` nên sdkjs không bao giờ được cấp khóa.
- `mode: 'edit'` (`viewer.mjs`: `editServer()`): đóng vai máy chủ một người dùng, cấp mọi khóa (`getLock` với `user` = `viewer1` = id cấu hình + chỉ số 1), trả `saveLock {false}`, `unSaveLock` / `savePartChanges` cho mỗi `saveChanges`. Thay đổi nằm trong editor; `save` gọi `api.asc_nativeGetFile()` (chuỗi `DOCY;v5;<size>;<base64>`, tương ứng `XLSY`, `PPTY`) → byte → x2t (`Editor.bin` → docx/xlsx/pptx, kèm media của file đã mở). Kiểm e2e (`poc/preview/e2e.cjs --modes edit`): gõ dấu hiệu, lưu, thấy trong `word/document.xml`, `xl/sharedStrings.xml`, `ppt/slides/slide1.xml`; mở lại file đã lưu ra đúng, ư vẫn hiện.
- Hạn chế: không đồng soạn thảo / lịch sử / bình luận / tự lưu; ảnh chèn mới khi sửa chưa được ghi; PDF của tài liệu đã sửa chỉ dùng ảnh của file gốc.

## 16. Tương thích font với Word trên Windows (10/11/2026)

- Editor và PDF **không dùng font cài trong máy**: sdkjs tự dựng chữ từ file trong gói font, x2t chỉ đọc `/working/fonts`. Cài Arial hay không, kết quả như nhau (PDF nhúng `Arimo`, `Tinos`, `Carlito`, `Cousine`, `Caladea`).
- Đo với font thật của Windows (script đo advance + metrics dọc, 423 ký tự: ASCII, Latin-1/Ext-A, tiếng Việt, dấu câu; 4 kiểu chữ): Arial↔Arimo, Times New Roman↔Tinos, Calibri↔Carlito, Courier New↔Cousine **lệch 0,0000 em** về độ rộng và trùng ascent/descent/lineGap/win metrics → ngắt dòng, ngắt trang như Word. Chỉ khác hình nét glyph và hinting. Calibri có 2 glyph không có trong Carlito.
- Khoảng trống thật: font không có bản thay thế tương thích số đo (mẫu `samples/word-fonts.docx`, 20 font) rơi về DejaVu Sans / Open Sans. Chênh độ rộng câu mẫu so với DejaVu Sans: Tahoma +12%, Segoe UI +14%, Georgia +26%, Trebuchet +26%, Palatino +14%, Century Gothic +16%, Garamond +40%, Arial Narrow +53%, Calibri Light +25%; Verdana −1%, Consolas −4%.
- Hướng khắc phục: (a) dùng font cài trong máy qua `queryLocalFonts()` (Chromium, cần cấp quyền) cho cả editor và x2t; (b) thêm font OFL tương thích số đo cho các tên phổ biến (Arial Narrow, Georgia, Segoe UI, Palatino...). Chưa làm, chờ chủ chọn.

## 17. Font thay thế cho Word + font trong máy (11/11/2026)

Làm cả hai hướng của §16. Công thức đo: `|advance(Word) − advance(thay thế)|` theo em trên 423 ký tự × 4 kiểu (mean = trung bình, max = lệch lớn nhất một ký tự; "Latin" gồm dấu câu và ký tự hiếm, "VN" là 134 chữ Việt); dòng = usWinAscent+usWinDescent / em (Word tính chiều cao dòng bằng số này), cột "sub" là font thay thế, trùng 100%.

| Font Word | Thay thế trong gói | Nguồn / giấy phép | Độ rộng (Regular, mean / max) | Dòng |
|---|---|---|---|---|
| Georgia | Gelasio | OFL, thiết kế để khớp Georgia | 0,001 / 0,254; VN 0 | 1,136 |
| Palatino Linotype, Book Antiqua | WasmPagella (TeX Gyre Pagella) | GUST, đổi tên | 0,021 / 0,292; VN 0,004 | 1,349 |
| Century Gothic | WasmAdventor (TeX Gyre Adventor) | GUST, đổi tên | 0,011 / 0,438; VN 0 | 1,191 |
| Segoe UI (+Light, Semibold) | WasmUI (Selawik + chữ Việt từ Roboto) | OFL (RFN → đổi tên) | Latin 0; VN 0,003 (Semibold 0,040: dùng Selawik Semibold, không có chữ đậm vừa) | 1,330 |
| Arial Narrow | WasmNarrow (Liberation Sans Narrow 1.07.4 + chữ Việt từ Arimo) | GPL + ngoại lệ font | 0,002 / 0,227 | 1,132 |
| Comic Sans MS | WasmComic (Comic Relief + chữ Việt từ Arimo, không có nghiêng) | OFL | 0,001 / 0,089 | 1,394 |
| Garamond | EB Garamond (rộng hơn Monotype Garamond ~5%) | OFL | 0,045 / 0,240; VN 0,027 | 1,125 |
| Cambria, Cambria Math | WasmCaladea (Caladea + chữ Việt từ Tinos) | OFL | khớp (Caladea thiết kế để khớp Cambria) | 1,172 |
| Tahoma, Verdana | WasmTahoma (Roboto), WasmVerdana (DejaVu Sans) | Apache-2.0 / Bitstream Vera | font gần giống có đủ chữ Việt; không có bản khớp số đo | đúng như Word |
| Consolas | Cousine (có sẵn) | Apache-2.0 | gần giống (cùng độ rộng đơn cách) | – |

- Mọi font thay thế được đặt ascent/descent bằng số của font Word (hhea, OS/2 typo và win, lineGap 0) nên chiều cao dòng trùng, chỉ phần độ rộng chữ khác.
- Chữ Việt thiếu trong Selawik/Liberation Narrow/Comic Relief được thêm từ font cho (Roboto/Arimo/Tinos): vẽ lại nét theo chiều cao chữ x / chữ hoa, kéo ngang đúng độ rộng chữ gốc. Không tìm được font mở khớp số đo của Tahoma, Verdana, Trebuchet, Calibri Light: giữ font gần giống.
- Font trong máy (`fonts/local-fonts.mjs`, `?localfonts=1`, SDK `enableLocalFonts()` / `open({localFonts})`): `queryLocalFonts()` chỉ có ở Chromium và cần cấp quyền (gọi trong cú nhấp chuột); host đọc tên font của tài liệu (`fontNames`) và chỉ gửi đúng các font đó. Viewer thêm vào danh sách font của editor (hook ở dòng cuối `AllFonts.js`, tạo bản ghi chọn font từ OS/2: panose, dải unicode, kiểu) và vào `/working/fonts` của x2t (worker `localFonts`), nên PDF nhúng đúng font của người dùng. Font có `fsType & 2` (cấm nhúng) vẫn hiện trong editor nhưng không vào PDF; `.ttc` chưa hỗ trợ; mặc định tắt.
- Giới hạn: sdkjs không lấy chữ thiếu từ font khác (Word thì có). Georgia, Century Gothic, Trebuchet, Garamond, Comic Sans của Windows thiếu một số chữ Việt tạo sẵn → ô vuông. Cách xử lý: khi tài liệu có chữ Việt, font trong máy thiếu chữ Việt **không dùng**, giữ font thay thế của gói (`prepareLocalFonts(list, {vietnamese})`, ghi log "lacks Vietnamese letters, the pack font stays"). Font Symbol/Wingdings vẫn hiện ô vuông (font biểu tượng, như trước).
- Kiểm tra: `node poc/preview/e2e.cjs --modes embedded --samples word-fonts.docx --local-fonts` (stub `queryLocalFonts` bằng font Windows thật của máy chủ): PDF nhúng Tahoma/Verdana/Segoe/Consolas/Palatino/Times/Arial/Calibri của máy và font gói cho Georgia/Garamond/Century Gothic/Comic.
