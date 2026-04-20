// Paletas y constantes visuales
export const MP = [
  { solid:"#7F77DD", light:"#EEEDFE", cardBorder:"#7F77DD", cardBg:"#f5f4ff" },
  { solid:"#E24B4A", light:"#FCEBEB", cardBorder:"#E24B4A", cardBg:"#fff5f5" },
  { solid:"#1D9E75", light:"#E1F5EE", cardBorder:"#1D9E75", cardBg:"#f0fdf7" },
  { solid:"#EF9F27", light:"#FAEEDA", cardBorder:"#EF9F27", cardBg:"#fffbf0" },
  { solid:"#378ADD", light:"#E6F1FB", cardBorder:"#378ADD", cardBg:"#f0f7ff" },
  { solid:"#D85A30", light:"#FAECE7", cardBorder:"#D85A30", cardBg:"#fff8f5" },
  { solid:"#993556", light:"#FBEAF0", cardBorder:"#993556", cardBg:"#fff5f8" },
  { solid:"#3B6D11", light:"#EAF3DE", cardBorder:"#3B6D11", cardBg:"#f4fbec" },
];

export const TAG_COLORS = {
  purple:{ bg:"#EEEDFE",text:"#3C3489",border:"#AFA9EC" },
  teal:  { bg:"#E1F5EE",text:"#085041",border:"#5DCAA5" },
  coral: { bg:"#FAECE7",text:"#712B13",border:"#F0997B" },
  pink:  { bg:"#FBEAF0",text:"#72243E",border:"#ED93B1" },
  amber: { bg:"#FAEEDA",text:"#633806",border:"#EF9F27" },
  blue:  { bg:"#E6F1FB",text:"#0C447C",border:"#85B7EB" },
  green: { bg:"#EAF3DE",text:"#27500A",border:"#97C459" },
};

export const QM = {
  Q1:{ label:"Hazlo ahora", sub:"Urgente+Importante",    bg:"#fff5f5",border:"#E24B4A",icon:"🔴" },
  Q2:{ label:"Planifícalo", sub:"Importante, no urgente", bg:"#f0f7ff",border:"#378ADD",icon:"🔵" },
  Q3:{ label:"Delégalo",    sub:"Urgente, no importante", bg:"#fffbf0",border:"#EF9F27",icon:"🟡" },
  Q4:{ label:"Elimínalo",   sub:"Ni urgente ni importante",bg:"#f9fafb",border:"#9ca3af",icon:"⚪" },
};

export const PROJECT_COLORS = ["#7F77DD","#E24B4A","#1D9E75","#EF9F27","#378ADD","#D85A30","#993556","#3B6D11"];
export const PROJECT_EMOJIS = ["🚀","📱","🌐","⚙️","🎯","💡","📊","🔧","✨","🏗️"];
export const DOW = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
export const TRANSPORT_KW = ["clase","inglés","ingles","curs","curso","class","jocs","training","entreno","gimnàs","gimnasio","gym","academia","formació","formacion"];

export function palOf(a){ return(!a||!a.length)?null:MP[a[0]]||null; }
