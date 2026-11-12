# office-wasm-viewer

Phần AGPL của office-wasm: viewer (iframe + postMessage), x2t.wasm, gói font Word-tương-thích, build x2t. Giấy phép: `LICENSE`, `NOTICE.md`.
Ba repo anh em cùng thư mục cha (E:\Projects\OnlyOffice): `office-wasm-sdk` (SDK host, trích văn bản, trang demo, **e2e**), `metafile-wasm` (WMF/EMF → SVG/PNG, dùng lại `upstream/` và `build/x2t` của repo này).

- Không commit/push khi chủ chưa yêu cầu; không ghi tên model / Co-Authored-By vào commit.
- Docker builder `x2t-builder` dùng chung (cache ~53 GB): không prune/xoá; mỗi lúc chỉ một build Docker (máy không pagefile).
- `artifacts/` và `upstream/` không vào git (build/tải riêng, sha512 ở `artifacts/*.sha512`). Sau mỗi lần thay gói editor: `npm run font-pack` rồi `npm run font-pack:check`.
- Cổng e2e: 8765 (host demo) / 8766 (viewer). Kiểm thử tích hợp chạy ở `../office-wasm-sdk` (`npm run e2e`), cần repo này ngay cạnh (hoặc `OFFICE_WASM_VIEWER`).
- Đóng gói: `npm run pack` (`tools/pack.mjs`, lớp core/editor/engine + site; từ chối cây bẩn → `--allow-dirty` chỉ để thử), `pack:verify`; `dist/` không vào git. Một site cho cả 3 editor (tách theo app không giảm băng thông). Domain được nhúng: `serve.cjs --config <file>` (`frameAncestors`, hỗ trợ `https://*.educora.vn`, đọc lại sau ≤2 s; luật trong `tools/access-policy.cjs`, mẫu `deploy/viewer.config.example.json`); `tokenScope` + env `OFFICE_WASM_TOKEN_SECRET` = chỉ phục vụ URL ký `/s/<hết hạn>.<chữ ký>/` (SDK ký bằng `office-wasm-sdk/server`). Kiểm: `npm run e2e:access` ở office-wasm-sdk. Chi tiết `docs/packaging.md`.
- Tài liệu: `docs/analysis.md` (đọc đầu tiên), `README.md`, `build/x2t/README.md`, `fonts/metric/SOURCE.md`.
