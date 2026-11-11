# office-wasm-viewer

Phần AGPL của office-wasm: viewer (iframe + postMessage), x2t.wasm, gói font Word-tương-thích, build x2t. Giấy phép: `LICENSE`, `NOTICE.md`.
Ba repo anh em cùng thư mục cha (E:\Projects\OnlyOffice): `office-wasm-sdk` (SDK host, trích văn bản, trang demo, **e2e**), `metafile-wasm` (WMF/EMF → SVG/PNG, dùng lại `upstream/` và `build/x2t` của repo này).

- Không commit/push khi chủ chưa yêu cầu; không ghi tên model / Co-Authored-By vào commit.
- Docker builder `x2t-builder` dùng chung (cache ~53 GB): không prune/xoá; mỗi lúc chỉ một build Docker (máy không pagefile).
- `artifacts/` và `upstream/` không vào git (build/tải riêng, sha512 ở `artifacts/*.sha512`). Sau mỗi lần thay gói editor: `npm run font-pack` rồi `npm run font-pack:check`.
- Cổng e2e: 8765 (host demo) / 8766 (viewer). Kiểm thử tích hợp chạy ở `../office-wasm-sdk` (`npm run e2e`), cần repo này ngay cạnh (hoặc `OFFICE_WASM_VIEWER`).
- Tài liệu: `docs/analysis.md` (đọc đầu tiên), `README.md`, `build/x2t/README.md`, `fonts/metric/SOURCE.md`.
