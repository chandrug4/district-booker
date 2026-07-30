// District.in seat layout parser
// SeatStatus: "0"=AVAILABLE, "0"+bestSeat=AVAILABLE(best), "1"=BOOKED, "1000/1001"=wheelchair
export function analyseSeatLayout(seatApiResponse, numTickets, preferredArea) {
  if (!seatApiResponse?.seatLayout?.colAreas?.objArea)
    return { ok: false, reason: 'no seatLayout in API response' };
  const areas = seatApiResponse.seatLayout.colAreas.objArea;
  const tempTransId = seatApiResponse.tempTransId;
  const product_id = seatApiResponse.product_id;
  const areaStats = [];
  for (const area of areas) {
    let available = 0, booked = 0;
    const availableSeats = [];
    for (const row of (area.objRow || [])) {
      for (const seat of (row.objSeat || [])) {
        const st = seat.SeatStatus;
        if (st === '1000' || st === '1001') continue;
        if (st === '0') {
          available++;
          availableSeats.push({ areaNum:area.AreaNum, areaCode:area.AreaCode, areaPrice:area.AreaPrice, gridRowId:row.GridRowId, phyRowId:row.PhyRowId, gridSeatNum:seat.GridSeatNum, seatNumber:seat.seatNumber, displaySeatNumber:seat.displaySeatNumber, isBest:seat.highlightSeat==='bestSeat' });
        } else if (st === '1') booked++;
      }
    }
    areaStats.push({ areaCode:area.AreaCode, areaDesc:area.AreaDesc, areaPrice:area.AreaPrice, available, booked, total:available+booked, availableSeats });
  }
  const bestRowOrder = { EL:['G','F','E','H','D','I','C','B','A','J'], PR:['M','L','N','K','O','P'] };
  let suggestion = null;
  for (const area of (preferredArea ? areaStats.filter(a=>a.areaCode===preferredArea) : areaStats)) {
    if (area.available < numTickets) continue;
    const byRow = {};
    for (const s of area.availableSeats) { if (!byRow[s.phyRowId]) byRow[s.phyRowId]=[]; byRow[s.phyRowId].push(s); }
    const rowOrder = bestRowOrder[area.areaCode] || [];
    const orderedRows = [...rowOrder.filter(r=>byRow[r]), ...Object.keys(byRow).filter(r=>!rowOrder.includes(r))];
    for (const rowId of orderedRows) {
      const seats = (byRow[rowId]||[]).sort((a,b)=>a.seatNumber-b.seatNumber);
      if (seats.length < numTickets) continue;
      for (let i=0; i<=seats.length-numTickets; i++) {
        const group = seats.slice(i,i+numTickets);
        if (group.every((s,j)=>j===0||s.seatNumber===group[j-1].seatNumber+1)) {
          suggestion = { area:area.areaCode, areaDesc:area.areaDesc, price:area.areaPrice, total:area.areaPrice*numTickets, seats:group, label:group.map(s=>`${rowId}${s.displaySeatNumber}`).join(', '), hasBest:group.some(s=>s.isBest) };
          break;
        }
      }
      if (suggestion) break;
    }
    if (suggestion) break;
  }
  return { ok:true, areas:areaStats, suggestion, tempTransId, product_id };
}
export function parseSeatApiBody(body) { try { return JSON.parse(body); } catch { return null; } }
