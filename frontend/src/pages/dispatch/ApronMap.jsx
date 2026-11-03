import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

const vehicleStyles = {
  AVAILABLE: ['可用', '#2e7d32'], RESERVED: ['已预留', '#1976d2'], WORKING: ['作业中', '#1976d2'],
  REFUELLING: ['补油中', '#ed6c02'], MAINTENANCE: ['维修中', '#757575']
};

export default function ApronMap({ flights, vehicles, refuelPoint, standbyPoint, selectedCandidate, targetFlight, focusedFlightId }) {
  const [selected, setSelected] = useState(focusedFlightId ? `flight:${focusedFlightId}` : targetFlight ? `flight:${targetFlight.id}` : '');
  const [expanded, setExpanded] = useState(false);
  const selectedFlight = flights.find((flight) => selected === `flight:${flight.id}`);
  const selectedVehicle = vehicles.find((vehicle) => selected === `vehicle:${vehicle.id}`);
  const points = [...flights, ...vehicles, refuelPoint, standbyPoint].filter(Boolean);
  const minX = Math.min(0, ...points.map((point) => point.x));
  const maxX = Math.max(24, ...points.map((point) => point.x));
  const minY = Math.min(0, ...points.map((point) => point.y));
  const maxY = Math.max(18, ...points.map((point) => point.y));
  const mapX = (x) => 80 + (x - minX) / (maxX - minX) * 840;
  const mapY = (y) => 150 + (y - minY) / (maxY - minY) * 270;
  const selectObject = (key) => setSelected(key);
  const keySelect = (event, key) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectObject(key); }
  };

  const drawing = (
    <svg viewBox="0 0 1000 560" width="100%" style={{ display: 'block', background: '#edf2ee' }} role="group" aria-label="机坪态势图，可选择航班或车辆">
      <rect x="30" y="120" width="940" height="330" rx="10" fill="#dce4e7" stroke="#b0bdc3" strokeWidth="2" />
      <line x1="30" y1="285" x2="970" y2="285" stroke="#bbc8cd" strokeDasharray="10 8" />
      <rect x="170" y="66" width="600" height="42" rx="6" fill="#647781" />
      <text x="470" y="93" textAnchor="middle" fontSize="16" fontWeight="700" fill="white">T1 航站楼</text>
      <rect x="472" y="440" width="76" height="70" fill="#cbd5d9" stroke="#bd9a36" strokeWidth="2" />
      <rect x="30" y="510" width="940" height="40" rx="4" fill="#52636b" />
      <line x1="70" y1="530" x2="930" y2="530" stroke="white" strokeWidth="3" strokeDasharray="26 20" />
      {[refuelPoint, standbyPoint].filter(Boolean).map((point, index) => (
        <g key={point.name} transform={`translate(${mapX(point.x)}, ${mapY(point.y)})`}>
          <rect x="-15" y="-10" width="30" height="20" rx="4" fill="#fff6d9" stroke="#897346" />
          <text y={index ? 44 : 27} textAnchor="middle" fontSize="12" fill="#4e493a">{point.name}</text>
        </g>
      ))}
      {selectedCandidate && targetFlight && <line x1={mapX(selectedCandidate.x)} y1={mapY(selectedCandidate.y)} x2={mapX(targetFlight.x)} y2={mapY(targetFlight.y)} stroke="#8e24aa" strokeWidth="3" strokeDasharray="8 6" />}
      {[...flights].sort((a, b) => Number(a.id === selectedFlight?.id) - Number(b.id === selectedFlight?.id)).map((flight) => {
        const focused = flight.id === selectedFlight?.id;
        return <g key={flight.id} role="button" tabIndex={0} aria-label={`查看航班 ${flight.flight_no} ${flight.gate}`} onClick={() => selectObject(`flight:${flight.id}`)} onKeyDown={(event) => keySelect(event, `flight:${flight.id}`)} style={{ cursor: 'pointer' }} transform={`translate(${mapX(flight.x)}, ${mapY(flight.y)})`}>
          <circle r={focused ? 24 : 18} fill={focused ? '#fff' : '#eaf0f2'} stroke={focused ? '#1565c0' : '#8d9fa8'} strokeWidth={focused ? 3 : 1.5} />
          <path d="M0 -14 L3 -3 L13 4 L13 7 L2 3 L2 10 L6 13 L0 11 L-6 13 L-2 10 L-2 3 L-13 7 L-13 4 L-3 -3 Z" fill={flight.priority === 3 ? '#b43b38' : '#33608e'} />
          {focused && <rect x="-72" y="27" width="144" height="25" rx="4" fill="white" stroke="#1565c0" />}
          <text y={focused ? 44 : 33} textAnchor="middle" fontSize={focused ? 14 : 12} fontWeight="700" fill="#253f4d">{focused ? `${flight.flight_no} · ${flight.gate}` : flight.gate}</text>
          <title>{`${flight.flight_no} · ${flight.gate}`}</title>
        </g>;
      })}
      {vehicles.map((vehicle) => {
        const focused = vehicle.id === selectedVehicle?.id || vehicle.id === selectedCandidate?.vehicleId;
        const [status, color] = vehicleStyles[vehicle.status] ?? [vehicle.status, '#757575'];
        return <g key={vehicle.id} role="button" tabIndex={0} aria-label={`查看车辆 ${vehicle.code}`} onClick={() => selectObject(`vehicle:${vehicle.id}`)} onKeyDown={(event) => keySelect(event, `vehicle:${vehicle.id}`)} style={{ cursor: 'pointer' }} transform={`translate(${mapX(vehicle.x)}, ${mapY(vehicle.y)})`}>
          {focused && <circle r="23" fill="white" stroke="#8e24aa" strokeWidth="2" />}
          <rect x="-13" y="-10" width="26" height="20" rx="5" fill={color} stroke="white" strokeWidth="2" />
          <text y="4" textAnchor="middle" fontSize="10" fontWeight="700" fill="white">油</text>
          <text y="-20" textAnchor="middle" fontSize="13" fontWeight="700" fill="#17282f" stroke="white" strokeWidth="4" paintOrder="stroke">{vehicle.code}</text>
          <title>{`${vehicle.code} · ${status} · ${vehicle.driver || '未绑定人员'} · ${vehicle.fuel_level.toLocaleString()} L`}</title>
        </g>;
      })}
    </svg>
  );

  const details = <Box aria-live="polite" sx={{ p: 1.25, bgcolor: 'grey.50', border: '1px solid', borderColor: 'divider', borderRadius: 1, minHeight: 62 }}>
    {selectedFlight ? <><Typography variant="body2" fontWeight={700}>{selectedFlight.flight_no} · 机位 {selectedFlight.gate}</Typography><Typography variant="caption">需油 {selectedFlight.fuel_needed.toLocaleString()} L{selectedFlight.fuel_remaining !== undefined && ` · ${selectedFlight.fuel_remaining == null ? '剩余量未记录' : `剩余 ${selectedFlight.fuel_remaining.toLocaleString()} L`}`} · 示意位置 ({selectedFlight.x}, {selectedFlight.y})</Typography></> : selectedVehicle ? <><Typography variant="body2" fontWeight={700}>{selectedVehicle.code} · {selectedVehicle.driver || '未绑定人员'} · {vehicleStyles[selectedVehicle.status]?.[0]}</Typography><Typography variant="caption">油量 {selectedVehicle.fuel_level.toLocaleString()} / {selectedVehicle.capacity.toLocaleString()} L · 示意位置 ({selectedVehicle.x}, {selectedVehicle.y})</Typography></> : <Typography variant="body2" color="text.secondary">点击标记查看完整信息。标记重叠时，可从上方列表选择。</Typography>}
  </Box>;

  const content = <Stack spacing={1.25}>
    <TextField select size="small" label="查看地图对象" value={selectedFlight || selectedVehicle ? selected : ''} onChange={(event) => selectObject(event.target.value)}>
      <MenuItem value="">请选择航班或车辆</MenuItem>
      {flights.map((flight) => <MenuItem key={flight.id} value={`flight:${flight.id}`}>{flight.flight_no} · {flight.gate}</MenuItem>)}
      {vehicles.map((vehicle) => <MenuItem key={vehicle.id} value={`vehicle:${vehicle.id}`}>{vehicle.code} · {vehicle.driver || '未绑定人员'}</MenuItem>)}
    </TextField>
    <Box sx={{ borderRadius: 1, overflow: 'hidden', border: '1px solid', borderColor: 'divider' }}>{drawing}</Box>
    {details}
    <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
      {[['航班机位', '#33608e'], ['可用车辆', '#2e7d32'], ['已预留 / 作业中', '#1976d2'], ['补油中', '#ed6c02'], ['维修中', '#757575']].map(([label, color]) => <Stack key={label} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}><Box component="span" sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: color }} /><Typography variant="caption">{label}</Typography></Stack>)}
    </Stack>
  </Stack>;

  return <>
    {content}
    <Button size="small" onClick={() => setExpanded(true)} sx={{ mt: 1 }}>展开地图</Button>
    <Dialog open={expanded} onClose={() => setExpanded(false)} fullWidth maxWidth="lg"><DialogTitle>机坪态势 · 示意位置</DialogTitle><DialogContent>{content}</DialogContent><DialogActions><Button onClick={() => setExpanded(false)}>关闭地图</Button></DialogActions></Dialog>
  </>;
}
