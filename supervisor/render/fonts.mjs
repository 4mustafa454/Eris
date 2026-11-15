// Registers the bundled DejaVu Sans (render/fonts/, license alongside) as "ErisSans", once per process.
import { GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { FONT_FAMILY } from './theme.mjs';

let registered = false;
export function registerFonts() {
  if (registered) return;
  const regular = GlobalFonts.registerFromPath(fileURLToPath(new URL('./fonts/DejaVuSans.ttf', import.meta.url)), FONT_FAMILY);
  const bold = GlobalFonts.registerFromPath(fileURLToPath(new URL('./fonts/DejaVuSans-Bold.ttf', import.meta.url)), FONT_FAMILY);
  if (!regular || !bold) throw new Error('could not register the bundled render fonts');
  registered = true;
}
