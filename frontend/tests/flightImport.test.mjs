import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFlightFile } from '../src/utils/flightImport.js';
const header = 'flightNo,gate,departureAt,fuelNeeded';
test('quoted CSV exported by spreadsheet preserves valid date and integer', () => {
  assert.deepEqual(parseFlightFile('flights.csv', '\uFEFF'+header+'\r\n"CA2026","E08","2026-11-08T12:00:00+08:00","6800"\r\n'), [{flightNo:'CA2026',gate:'E08',departureAt:'2026-11-08T12:00:00+08:00',fuelNeeded:'6800'}]);
});
test('quoted comma, escaped quote and newline stay in one cell', () => {
  assert.equal(parseFlightFile('flights.csv',header+'\nCA1,"Gate, ""A""\nNorth",2026-11-08T12:00:00Z,1')[0].gate,'Gate, "A"\nNorth');
});
test('reject malformed quotes, columns and headers instead of truncating data', () => {
  for(const content of [header+'\nCA1,"A,2026,1',header+'\nCA1,A,2026,1,extra','flightNo,flightNo\nCA1,CA2',header+'\nCA1,A']) assert.throws(()=>parseFlightFile('f.csv',content));
});
test('JSON BOM is accepted and unsupported formats are explained', () => {
  assert.deepEqual(parseFlightFile('f.json','\uFEFF[{"flightNo":"CA1"}]'),[{flightNo:'CA1'}]);
  for(const [name,content] of [['f.json','{}'],['f.json','[]'],['f.json','{'],['f.xlsx','binary']]) assert.throws(()=>parseFlightFile(name,content));
});
