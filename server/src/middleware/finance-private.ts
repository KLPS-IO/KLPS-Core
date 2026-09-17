import { Response, NextFunction } from 'express';
import { DataRoomRequest } from '../services/data-room.service';

// Raw Finance OS includes private tax, shareholder and bank evidence.
// Investor publication remains the separately permissioned Data Room document workflow.
export function requirePrivateFinance(req: DataRoomRequest, res: Response, next: NextFunction) {
  if (req.dataRoomUser?.role !== 'founder_admin') {
    return res.status(403).json({status:'error',code:'private_finance_required',message:'Founder/admin access is required for working Finance OS records.'});
  }
  next();
}
