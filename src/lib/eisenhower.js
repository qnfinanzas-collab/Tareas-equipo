import { daysUntil } from "./date.js";

export function getQ(t){
  const d=daysUntil(t.dueDate);
  const u=d<=3;
  const i=t.priority==="alta"||t.priority==="media";
  return u&&i?"Q1":!u&&i?"Q2":u?"Q3":"Q4";
}
