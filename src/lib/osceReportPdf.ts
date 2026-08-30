import { jsPDF } from 'jspdf';
import reshaper from 'arabic-persian-reshaper';

export interface OsceReportLabels {
  certificateTitle: string;
  officialReport: string;
  totalScore: string;
  station: string;
  patient: string;
  date: string;
  sessionId: string;
  scoreCommunication: string;
  scoreHistory: string;
  scoreClinicalReason: string;
  scoreOrganization: string;
  scoreClosing: string;
  strengths: string;
  weaknesses: string;
  missedQuestions: string;
  clinicalErrors: string;
  recommendations: string;
  idealApproach: string;
  fullReport: string;
  certifiedSeal: string;
  platformName: string;
}

export interface OsceReportData {
  sessionId: string;
  stationTitle: string;
  patientName: string;
  result: Record<string, unknown>;
  isAr: boolean;
  labels: OsceReportLabels;
}

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 14;
const CONTENT_W = PAGE_W - MARGIN * 2;
const LINE_H = 5.2;

let cairoRegularBase64: string | null = null;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function loadFontBase64(): Promise<string> {
  if (cairoRegularBase64) return cairoRegularBase64;
  const res = await fetch('/fonts/Cairo-Regular.ttf');
  if (!res.ok) throw new Error('font-load-failed');
  cairoRegularBase64 = arrayBufferToBase64(await res.arrayBuffer());
  return cairoRegularBase64;
}

async function loadReportLogo(): Promise<string | null> {
  for (const path of ['/report-logo.png', '/synoza-wordmark.png', '/synoza-logo.png', '/synoza-icon.png']) {
    try {
      const res = await fetch(path);
      if (!res.ok) continue;
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('logo-read-failed'));
        reader.readAsDataURL(blob);
      });
    } catch {
      /* try next */
    }
  }
  return null;
}

type PreparedReportLogo = {
  dataUrl: string;
  widthMm: number;
  heightMm: number;
};

function isLogoPixelEmpty(r: number, g: number, b: number, a: number): boolean {
  if (a <= 12) return true;
  if (r > 245 && g > 245 && b > 245) return true;
  if (r < 18 && g < 18 && b < 18) return true;
  return false;
}

async function trimLogoDataUrl(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }

      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);

      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let top = height;
      let bottom = 0;
      let left = width;
      let right = 0;

      for (let py = 0; py < height; py += 1) {
        for (let px = 0; px < width; px += 1) {
          const i = (py * width + px) * 4;
          if (!isLogoPixelEmpty(data[i], data[i + 1], data[i + 2], data[i + 3])) {
            top = Math.min(top, py);
            bottom = Math.max(bottom, py);
            left = Math.min(left, px);
            right = Math.max(right, px);
          }
        }
      }

      if (top >= bottom || left >= right) {
        resolve(dataUrl);
        return;
      }

      const pad = Math.max(2, Math.round(Math.min(width, height) * 0.01));
      const cropX = Math.max(0, left - pad);
      const cropY = Math.max(0, top - pad);
      const cropRight = Math.min(width, right + pad + 1);
      const cropBottom = Math.min(height, bottom + pad + 1);
      const cropW = cropRight - cropX;
      const cropH = cropBottom - cropY;

      const out = document.createElement('canvas');
      out.width = cropW;
      out.height = cropH;
      out.getContext('2d')!.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      resolve(out.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function loadImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('logo-size-failed'));
    img.src = dataUrl;
  });
}

async function prepareReportLogo(dataUrl: string | null): Promise<PreparedReportLogo | null> {
  if (!dataUrl) return null;
  try {
    const trimmed = await trimLogoDataUrl(dataUrl);
    const { width, height } = await loadImageSize(trimmed);
    if (!width || !height) return null;

    const aspect = width / height;
    const targetH = 12;
    let logoW = targetH * aspect;
    let logoH = targetH;
    const maxW = 48;
    if (logoW > maxW) {
      logoW = maxW;
      logoH = logoW / aspect;
    }

    return { dataUrl: trimmed, widthMm: logoW, heightMm: logoH };
  } catch {
    return null;
  }
}

function prepareText(text: string, isAr: boolean): string {
  if (!text) return '';
  if (!isAr) return text;
  return reshaper.ArabicShaper.convertArabic(text);
}

function scoreColor(score: number): [number, number, number] {
  if (score >= 70) return [5, 150, 105];
  if (score >= 50) return [217, 119, 6];
  return [220, 38, 38];
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^[-*]\s+/gm, '• ')
    .trim();
}

function setupDoc(fontBase64: string, isAr: boolean): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  doc.addFileToVFS('Cairo-Regular.ttf', fontBase64);
  doc.addFont('Cairo-Regular.ttf', 'Cairo', 'normal');
  doc.addFont('Cairo-Regular.ttf', 'Cairo', 'bold');
  doc.setFont('Cairo', 'normal');
  if (isAr) doc.setR2L(true);
  return doc;
}

function textX(isAr: boolean): number {
  return isAr ? PAGE_W - MARGIN : MARGIN;
}

function ensureSpace(doc: jsPDF, y: number, needed: number): number {
  if (y + needed > PAGE_H - MARGIN) {
    doc.addPage();
    return MARGIN + 4;
  }
  return y;
}

function drawPageBackground(doc: jsPDF) {
  doc.setFillColor(252, 251, 247);
  doc.rect(0, 0, PAGE_W, PAGE_H, 'F');
  // Outer certificate border
  doc.setDrawColor(232, 228, 216);
  doc.setLineWidth(0.6);
  doc.roundedRect(MARGIN - 4, MARGIN - 4, CONTENT_W + 8, PAGE_H - (MARGIN * 2) + 8, 4, 4, 'S');
}

function drawHeader(
  doc: jsPDF,
  labels: OsceReportLabels,
  logo: PreparedReportLogo | null,
  isAr: boolean,
): number {
  drawPageBackground(doc);
  const y = MARGIN + 4;
  const x = textX(isAr);
  let headerBottom = y + 6;

  // synoza logotype
  doc.setFont('Cairo', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(18, 36, 43);
  doc.text('synoza', x, y + 4, { align: isAr ? 'right' : 'left' });
  headerBottom = y + 6;

  // Subtitle
  doc.setFont('Cairo', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(100, 116, 139);
  doc.text('OSCE Evaluation Certificate', x, headerBottom + 3, { align: isAr ? 'right' : 'left' });

  // Official Evaluation Report on the right
  const rightX = isAr ? MARGIN : PAGE_W - MARGIN;
  doc.setFont('Cairo', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(51, 65, 85);
  doc.text(prepareText(labels.officialReport || 'Official Evaluation Report', isAr), rightX, y + 2, {
    align: isAr ? 'left' : 'right',
  });

  // Terracotta accent line under Official Evaluation Report
  const lineW = 32;
  const lineStartX = isAr ? MARGIN : PAGE_W - MARGIN - lineW;
  doc.setDrawColor(194, 94, 74);
  doc.setLineWidth(1.2);
  doc.line(lineStartX, y + 5, lineStartX + lineW, y + 5);

  const dividerY = headerBottom + 8;
  doc.setDrawColor(232, 228, 216);
  doc.setLineWidth(0.4);
  doc.line(MARGIN, dividerY, PAGE_W - MARGIN, dividerY);
  return dividerY + 5;
}

function drawMeta(
  doc: jsPDF,
  data: OsceReportData,
  dateStr: string,
  y: number,
  isAr: boolean,
): number {
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(236, 231, 220);
  doc.setLineWidth(0.4);
  doc.roundedRect(MARGIN, y, CONTENT_W, 24, 3, 3, 'FD');

  const colW = (CONTENT_W - 32) / 2;

  // Station
  doc.setFont('Cairo', 'bold');
  doc.setFontSize(6.5);
  doc.setTextColor(148, 163, 184);
  doc.text('STATION', MARGIN + 4, y + 5);
  doc.setFontSize(8.5);
  doc.setTextColor(18, 36, 43);
  doc.text(data.stationTitle.slice(0, 36), MARGIN + 4, y + 10);

  // Date
  doc.setFont('Cairo', 'bold');
  doc.setFontSize(6.5);
  doc.setTextColor(148, 163, 184);
  doc.text('DATE', MARGIN + 4, y + 16);
  doc.setFont('Cairo', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(51, 65, 85);
  doc.text(dateStr, MARGIN + 4, y + 20.5);

  // Divider between col 1 & 2
  doc.setDrawColor(241, 245, 249);
  doc.line(MARGIN + colW + 4, y + 3, MARGIN + colW + 4, y + 21);

  // Patient
  doc.setFont('Cairo', 'bold');
  doc.setFontSize(6.5);
  doc.setTextColor(148, 163, 184);
  doc.text('PATIENT', MARGIN + colW + 8, y + 5);
  doc.setFontSize(8.5);
  doc.setTextColor(18, 36, 43);
  doc.text(data.patientName.slice(0, 32), MARGIN + colW + 8, y + 10);

  // Session ID
  doc.setFont('Cairo', 'bold');
  doc.setFontSize(6.5);
  doc.setTextColor(148, 163, 184);
  doc.text('SESSION ID', MARGIN + colW + 8, y + 16);
  doc.setFont('Cairo', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(71, 85, 105);
  doc.text(data.sessionId.slice(0, 12), MARGIN + colW + 8, y + 20.5);

  // Seal Badge on Right
  const sealCx = PAGE_W - MARGIN - 14;
  const sealCy = y + 12;
  doc.setFillColor(233, 241, 235);
  doc.setDrawColor(118, 155, 130);
  doc.setLineWidth(0.6);
  doc.circle(sealCx, sealCy, 9, 'FD');

  doc.setFont('Cairo', 'bold');
  doc.setFontSize(5.5);
  doc.setTextColor(45, 82, 57);
  doc.text('SYNOZA', sealCx, sealCy - 2.5, { align: 'center' });
  doc.setFontSize(4.5);
  doc.text('CERTIFIED', sealCx, sealCy + 0.5, { align: 'center' });
  doc.setFontSize(5);
  doc.text('OSCE', sealCx, sealCy + 3.5, { align: 'center' });

  return y + 28;
}

function drawScores(doc: jsPDF, data: OsceReportData, y: number, isAr: boolean): number {
  const total = Number(data.result.totalScore ?? 0);
  const scores = [
    ['Communication', Number(data.result.communicationScore ?? 0)],
    ['History', Number(data.result.historyTakingScore ?? 0)],
    ['Clinical Reasoning', Number(data.result.clinicalReasonScore ?? 0)],
    ['Organization', Number(data.result.organizationScore ?? 0)],
    ['Closing', Number(data.result.closingScore ?? 0)],
  ] as const;

  doc.setFillColor(250, 245, 236);
  doc.setDrawColor(235, 226, 206);
  doc.setLineWidth(0.4);
  doc.roundedRect(MARGIN, y, CONTENT_W, 26, 3, 3, 'FD');

  // Total Score on Left
  doc.setFont('Cairo', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text('TOTAL SCORE', MARGIN + 6, y + 8);

  doc.setFont('Cairo', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(27, 67, 50);
  doc.text(`${total}%`, MARGIN + 6, y + 19);

  // Vertical divider
  doc.setDrawColor(235, 226, 206);
  doc.line(MARGIN + 36, y + 4, MARGIN + 36, y + 22);

  // 5 Category columns
  const gridStartX = MARGIN + 40;
  const gridW = CONTENT_W - 44;
  const colW = gridW / 5;

  scores.forEach(([label, value], i) => {
    const cx = gridStartX + i * colW + colW / 2;

    doc.setFont('Cairo', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(71, 85, 105);
    const labelLines = doc.splitTextToSize(label, colW - 2) as string[];
    doc.text(labelLines.slice(0, 2), cx, y + 8, { align: 'center' });

    doc.setFont('Cairo', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(18, 36, 43);
    doc.text(`${value}%`, cx, y + 19, { align: 'center' });
  });

  return y + 31;
}

function drawSection(
  doc: jsPDF,
  title: string,
  body: string,
  y: number,
  isAr: boolean,
): number {
  if (!body?.trim()) return y;

  const prepared = prepareText(stripMarkdown(body), isAr);
  const bodyLines = doc.splitTextToSize(prepared, CONTENT_W - 42) as string[];
  const minBoxH = 16;
  const calculatedH = 10 + bodyLines.length * 4.4;
  const boxH = Math.max(minBoxH, calculatedH);

  y = ensureSpace(doc, y, boxH + 4);

  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(236, 231, 220);
  doc.setLineWidth(0.4);
  doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 3, 3, 'FD');

  // Dark badge circle
  const badgeCx = MARGIN + 8;
  const badgeCy = y + 7;
  doc.setFillColor(18, 43, 52);
  doc.circle(badgeCx, badgeCy, 4.5, 'F');

  // Title
  doc.setFont('Cairo', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(18, 36, 43);
  const titleLines = doc.splitTextToSize(title, 26) as string[];
  doc.text(titleLines.slice(0, 2), MARGIN + 14, y + 6);

  // Vertical divider between title and content
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.3);
  doc.line(MARGIN + 36, y + 3, MARGIN + 36, y + boxH - 3);

  // Content text
  doc.setFont('Cairo', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(51, 65, 85);
  let lineY = y + 6.5;
  for (const line of bodyLines) {
    doc.text(line, MARGIN + 40, lineY, { maxWidth: CONTENT_W - 44 });
    lineY += 4.4;
  }

  return y + boxH + 3.5;
}

function drawFooter(doc: jsPDF, y: number, isAr: boolean): number {
  y = ensureSpace(doc, y, 32);

  // Doctor Signature
  doc.setFont('Cairo', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(18, 36, 43);
  doc.text('Dr. Mahmoud Nasser', MARGIN + 6, y + 14);
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.3);
  doc.line(MARGIN + 6, y + 10, MARGIN + 40, y + 10);

  // Center slogan
  doc.setFont('Cairo', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text('Building Clinical Connections', PAGE_W / 2, y + 12, { align: 'center' });

  // Official Seal on Right
  const sealCx = PAGE_W - MARGIN - 18;
  const sealCy = y + 10;
  doc.setDrawColor(16, 185, 129);
  doc.setLineWidth(0.6);
  doc.circle(sealCx, sealCy, 8.5, 'S');
  doc.setLineWidth(0.2);
  doc.circle(sealCx, sealCy, 7, 'S');

  doc.setFont('Cairo', 'bold');
  doc.setFontSize(4);
  doc.setTextColor(5, 150, 105);
  doc.text('SYNOZA PLATFORM', sealCx, sealCy - 1.5, { align: 'center' });
  doc.text('OFFICIAL DOCUMENT', sealCx, sealCy + 2, { align: 'center' });

  // Bottom Security Ribbon
  const ribbonY = PAGE_H - MARGIN + 3.5;
  doc.setFillColor(18, 36, 43);
  doc.rect(MARGIN - 4, ribbonY - 4, CONTENT_W + 8, 8, 'F');

  doc.setFont('Cairo', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(203, 213, 225);
  doc.text('SECURE · VERIFIED · TRUSTED', MARGIN + 2, ribbonY + 1);
  doc.text('WWW.SYNOZAA.COM', PAGE_W / 2, ribbonY + 1, { align: 'center' });

  return ribbonY;
}

export async function downloadOsceReportPdf(data: OsceReportData): Promise<void> {
  const [fontBase64, logoDataUrl] = await Promise.all([loadFontBase64(), loadReportLogo()]);
  const logo = await prepareReportLogo(logoDataUrl);
  const { result, labels, isAr } = data;
  const doc = setupDoc(fontBase64, isAr);

  const dateStr = new Date().toLocaleString(isAr ? 'ar-EG' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  let y = drawHeader(doc, labels, logo, isAr);
  y = drawMeta(doc, data, dateStr, y, isAr);
  y = drawScores(doc, data, y, isAr);

  const sections = [
    ['STRENGTHS', String(result.strengths ?? '')],
    ['WEAKNESSES', String(result.weaknesses ?? '')],
    ['MISSED QUESTIONS', String(result.missedQuestions ?? '')],
    ['CLINICAL ERRORS', String(result.clinicalErrors ?? '')],
    ['RECOMMENDATIONS', String(result.recommendations ?? '')],
    ['IDEAL APPROACH', String(result.idealApproach ?? '')],
  ] as const;

  for (const [title, body] of sections) {
    y = drawSection(doc, title, body, y, isAr);
  }

  drawFooter(doc, y + 4, isAr);

  doc.save(`synoza-report-${data.sessionId.slice(0, 8)}.pdf`);
}
