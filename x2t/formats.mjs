// Format ids from core/Common/OfficeFileFormats.h (ONLYOFFICE / Euro-Office core v9.3.2).
export const FORMAT = {
  docx: 65, doc: 66, odt: 67, rtf: 68, txt: 69, html: 70, mht: 71, epub: 72, fb2: 73, docm: 75, dotx: 76,
  pptx: 129, ppt: 130, odp: 131, ppsx: 132, pptm: 133, potx: 135,
  xlsx: 257, xls: 258, ods: 259, csv: 260, xlsm: 261, xltx: 262, xlsb: 264,
  pdf: 513,
  jpg: 1025, png: 1029,
  // internal editor binaries ("Editor.bin")
  doct: 0x1001, xlst: 0x1002, pptt: 0x1003,
  canvasWord: 0x2001, canvasSpreadsheet: 0x2002, canvasPresentation: 0x2003,
};

const WORD = ['docx', 'doc', 'odt', 'rtf', 'txt', 'html', 'docm', 'dotx', 'epub', 'fb2', 'mht'];
const CELL = ['xlsx', 'xls', 'ods', 'csv', 'xlsm', 'xltx', 'xlsb'];
const SLIDE = ['pptx', 'ppt', 'odp', 'ppsx', 'pptm', 'potx'];

export const extOf = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/** @returns {'word'|'cell'|'slide'|null} editor family for a file name */
export function docTypeOf(name) {
  const ext = extOf(name);
  if (WORD.includes(ext)) return 'word';
  if (CELL.includes(ext)) return 'cell';
  if (SLIDE.includes(ext)) return 'slide';
  return null;
}

const MEDIA_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' };

/**
 * MIME type for a media file written by x2t. Needed for blob URLs: a browser only decodes an SVG image when the
 * blob says it is one (x2t turns every WMF/EMF picture, e.g. MathType equations, into an SVG for the editor).
 */
export const mediaMimeOf = (name) => MEDIA_MIME[extOf(name)] || 'application/octet-stream';

const escXml =(s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Build the TaskQueueDataConvert XML that x2t's main() reads.
 * Without `formatTo` x2t picks the route from the output extension (".bin" -> editor binary).
 */
export function buildParamsXml({ fileFrom, fileTo, formatTo, fontDir = '/working/fonts/', themeDir = '/working/themes', extraXml = '' }) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
    + '<m_sFontDir>' + escXml(fontDir) + '</m_sFontDir>'
    + '<m_sThemeDir>' + escXml(themeDir) + '</m_sThemeDir>'
    + '<m_sFileFrom>' + escXml(fileFrom) + '</m_sFileFrom>'
    + '<m_sFileTo>' + escXml(fileTo) + '</m_sFileTo>'
    + (formatTo ? '<m_nFormatTo>' + Number(formatTo) + '</m_nFormatTo>' : '')
    + '<m_bIsNoBase64>false</m_bIsNoBase64>'
    + '<m_nCsvTxtEncoding>46</m_nCsvTxtEncoding>' // 46 = UTF-8
    + '<m_nCsvDelimiter>4</m_nCsvDelimiter>' // 4 = comma
    + extraXml
    + '</TaskQueueDataConvert>';
}
