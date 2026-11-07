export function csvRows(input) {
  const text = input.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false;
  const pushCell = () => { row.push(cell.trim()); cell = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += char;
    } else if (char === ',') pushCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      pushCell(); if (row.some((value) => value !== '')) rows.push(row); row = [];
    } else if (char === '"') {
      if (cell.trim() || closed) throw new Error('CSV 引号位置不正确，请使用标准 CSV 文件');
      cell = ''; quoted = true;
    } else {
      if (closed && char.trim()) throw new Error('CSV 引号后存在多余内容');
      if (!closed) cell += char;
    }
  }
  if (quoted) throw new Error('CSV 有未闭合的双引号');
  pushCell(); if (row.some((value) => value !== '')) rows.push(row);
  const [keys, ...records] = rows;
  if (!keys || records.length === 0) throw new Error('文件须包含表头及至少一条航班数据');
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw new Error('CSV 表头不能为空或重复');
  const missing = ['flightNo', 'gate', 'departureAt', 'fuelNeeded'].filter((key) => !keys.includes(key));
  if (missing.length) throw new Error(`CSV 缺少必填列：${missing.join('、')}`);
  return records.map((values, index) => {
    if (values.length !== keys.length) throw new Error(`第 ${index + 1} 条数据的列数与表头不一致`);
    return Object.fromEntries(keys.map((key, column) => [key, values[column]]));
  });
}

export function parseFlightFile(name, content) {
  const text = content.replace(/^\uFEFF/, '');
  if (/\.csv$/i.test(name)) return csvRows(text);
  if (!/\.json$/i.test(name)) throw new Error('请将 Excel 文件另存为 CSV UTF-8，或选择 JSON 数组文件');
  let rows;
  try { rows = JSON.parse(text); } catch { throw new Error('JSON 格式不正确，请检查引号、逗号及括号'); }
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('JSON 须为包含至少一条航班数据的数组');
  return rows;
}
