# Sources of the metric-compatible fonts

Inputs of `../metric-src/build-metric-fonts.py` (not stored in the repository; download, check the checksum, run the script).
Everything is untrusted until the checksum matches. Built 10/11/2026.

| Input | Where from | sha256 |
|---|---|---|
| `gelasio/Gelasio[wght].ttf` | https://github.com/SorkinType/Gelasio, mirror https://github.com/google/fonts/tree/main/ofl/gelasio | 4daecea457258c9ebeb8bc99ed3fd24353618bfad3ea4b93fa0b5d0468fc04e4 |
| `gelasio/Gelasio-Italic[wght].ttf` | same | 52559e845a4d33514e5f93bb9ae7dbeae1894a53f2c565a15f18af40cd337c09 |
| `ebg/EBGaramond[wght].ttf` | https://github.com/octaviopardo/EBGaramond12, mirror https://github.com/google/fonts/tree/main/ofl/ebgaramond | ef9512f92f6d579e5dc75af59a5a4b1b8b47d2eda89e00b954d44520e5369027 |
| `ebg/EBGaramond-Italic[wght].ttf` | same | bba2c4499c93c9612b90b9825d32b07da52fce2fe57562a1eb6b833553f93c4e |
| `comic/ComicRelief-Regular.ttf` | Comic Relief (Loudifier), mirror https://github.com/google/fonts/tree/main/ofl/comicrelief | 9ef4958ab06385d91f635f83a15569786b243f9d010cfb3f9a5cdda593c7bc22 |
| `comic/ComicRelief-Bold.ttf` | same | 33aee007212b696afd57d50c901135cd723cd188f7ad98f3a1c572ea64e8f0d5 |
| `gyre/texgyrepagella-regular.otf` | https://mirrors.ctan.org/fonts/tex-gyre/opentype/ (TeX Gyre, GUST Font Licence) | 44e64260716d8f2bbe412baa1ee99b7c995190ac4573177c24def0b9200438c7 |
| `gyre/texgyrepagella-bold.otf` | same | dd4f9b69f0b24f1fb9be8634abf1fce2009e5c68a30842a3e9f5d6e535900abd |
| `gyre/texgyrepagella-italic.otf` | same | 069bb27f48eb98a741715227fc6e4b7baf3639c29fc13925f70d1ed8884ac29a |
| `gyre/texgyrepagella-bolditalic.otf` | same | 556fd64655a92bd9f5485ae2c03f7b9cdaf745a27a91d7edb3c3abde997206d2 |
| `gyre/texgyreadventor-regular.otf` | same | ee265c1c9728be9491c7f0d7fcdcb2f97bc35040a6dc1f9815265cee333e155b |
| `gyre/texgyreadventor-bold.otf` | same | e373ae29c808c6d9149e3add46564f9acdb6ebfcd0ee311f6a55560226994720 |
| `gyre/texgyreadventor-italic.otf` | same | 1f21a5a07c207f70785dd6cbe4fcb2e0a3f60823b219efb01790a72d8a61b3cb |
| `gyre/texgyreadventor-bolditalic.otf` | same | d524c5596812aeee8fed5c81739056ada7a305b84591ea30e30c025b860b311d |
| `selawik/s.zip` | https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip | 3f62c51e05e3b5a1e6241cf92a371f0be2ea1183aa87b30718bbd40832a8d423 |
| `deb107b/f.deb` | https://deb.debian.org/debian/pool/main/f/fonts-liberation/fonts-liberation_1.07.4-11_all.deb | efd381517f958b01969343634ffcbdd60056be7779af84c6f53a005090430204 |
| donors Roboto, Arimo, Tinos, Caladea, DejaVu Sans | the font pack of the editor build (`artifacts/onlyoffice-editor/fonts/fonts/`) | not pinned here |

The checksums of the built fonts are in `metric-fonts.json` (`sha256`).

Licences: Gelasio, EB Garamond, Comic Relief, Selawik, Roboto, Caladea: SIL OFL 1.1 (`OFL-*.txt`); Arimo, Tinos: Apache-2.0;
Liberation Narrow 1.07.4: GPL-2 with font exception (`Liberation-copyright.txt`); TeX Gyre: GUST Font Licence (`GUST-FONT-LICENSE.txt`).
Fonts with a Reserved Font Name (Selawik, Liberation) and the TeX Gyre fonts (modified versions must be renamed) are published under the
`Wasm...` names. Selawik has no Vietnamese letters and no italic; Liberation Narrow and Comic Relief have no Vietnamese letters; these were
added from the donors (outline scaled to the x-height, advance width of the base letter).

Layout expected by the script (`<download dir>`): `gelasio/`, `ebg/`, `comic/`, `gyre/` hold the downloaded files as named above; `selawik/x/`
is `s.zip` extracted (`selawk.ttf`, `selawkb.ttf`, `selawkl.ttf`, `selawksb.ttf`, `LICENSE.txt`); `deb107b/` holds the four
`LiberationSansNarrow-*.ttf` and `copyright` extracted from `f.deb` (the .deb above, saved as `f.deb`). Extract the archives into a new
empty folder (untrusted data) and never run anything from them.
