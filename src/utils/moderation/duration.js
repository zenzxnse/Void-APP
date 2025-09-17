export function parseDurationSeconds(input) {
  if (!input) return null;
  
  const s = String(input).trim().toLowerCase();
  
  // Allow pure minutes integer (legacy)
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 60;

  const units = {
    w: 604800, // 7 * 24 * 60 * 60 seconds
    d: 86400,  // 24 * 60 * 60 seconds  
    h: 3600,   // 60 * 60 seconds
    m: 60,     // 60 seconds
    s: 1       // 1 second
  };

  const regex = /(\d+)\s*([wdhms])/g;
  let total = 0;
  let match;
  
  while ((match = regex.exec(s))) {
    const [, value, unit] = match;
    total += parseInt(value, 10) * units[unit];
  }
  
  return total || null;
}

export function prettySecs(total) {
  let s = Math.floor(total);
  const parts = [];
  const days = Math.floor(s / 86400); s -= days * 86400;
  const hrs  = Math.floor(s / 3600);  s -= hrs * 3600;
  const mins = Math.floor(s / 60);    s -= mins * 60;
  if (days) parts.push(`${days}d`);
  if (hrs)  parts.push(`${hrs}h`);
  if (mins) parts.push(`${mins}m`);
  if (!parts.length || s) parts.push(`${s}s`);
  return parts.join(' ');
}

export function formatType(type) {
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
}