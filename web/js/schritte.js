// "So einfach geht's": E-Mail an Vermieter*in (wird nur im Browser erzeugt) + Werte für das Marktstammdatenregister
import { nf } from './ergebnis.js';

let kontext = {adresse: null, module: 2, wpJeModul: 430, breite: 1.72, hoehe: 1.13, aufstellung: 'senkrecht'};
let bearbeitet = false;
const $ = id => document.getElementById(id);

function frist() {
  const d = new Date(Date.now() + 21 * 864e5);
  return d.toLocaleDateString('de-DE', {day: '2-digit', month: '2-digit', year: 'numeric'});
}

export function mailText() {
  const k = kontext, name = ($('mail-name').value || '').trim(), whg = ($('mail-wohnung').value || '').trim();
  const adr = k.adresse ? `${k.adresse.s} ${k.adresse.n}, ${k.adresse.p} Berlin` : '[Straße Hausnummer], [PLZ] Berlin';
  const wp = k.module * k.wpJeModul;
  const betreff = `Bitte um Zustimmung: Balkonkraftwerk an meinem Balkon${k.adresse ? ` (${k.adresse.s} ${k.adresse.n})` : ''}`;
  const text = [
    'Sehr geehrte Damen und Herren,',
    '',
    `ich wohne in der ${adr}${whg ? ` (Wohnung: ${whg})` : ''} und möchte an meinem Balkon ein kleines Balkonkraftwerk (Steckersolargerät) anbringen. Dafür bitte ich Sie um Ihre Zustimmung nach § 554 BGB.`,
    '',
    'Geplant ist:',
    `- ${k.module === 1 ? '1 Solarmodul' : `${k.module} Solarmodule`}, ${k.module === 1 ? '' : 'je '}etwa ${nf(k.breite, 2)} × ${nf(k.hoehe, 2)} m, zusammen rund ${nf(wp)} Watt`,
    '- ein Wechselrichter mit höchstens 800 Watt',
    `- Befestigung mit einer Halterung am Balkongeländer, ${k.aufstellung === 'geneigt' ? 'leicht ausgestellt' : 'senkrecht'}, ohne Bohren in Fassade oder Geländer`,
    '- Anschluss an eine vorhandene Steckdose',
    '',
    'Die Montage erfolgt sicher und sturmfest nach der Anleitung des Herstellers. Das Gerät melde ich im Marktstammdatenregister an. Gern stimme ich Art und Ort der Befestigung mit Ihnen ab und kläre mit meiner Haftpflichtversicherung, dass das Gerät mitversichert ist. Bei einem Auszug baue ich alles wieder ab.',
    '',
    `Über eine Rückmeldung bis zum ${frist()} freue ich mich.`,
    '',
    'Mit freundlichen Grüßen',
    name || '[Dein Name]',
  ].join('\n');
  return {betreff, text};
}

function aktualisiere(erzwingen = false) {
  const {betreff, text} = mailText();
  if (!bearbeitet || erzwingen) { $('mail-text').value = text; bearbeitet = false; $('mail-neu').hidden = true; }
  $('mail-betreff').textContent = betreff;
  const k = kontext, wp = k.module * k.wpJeModul;
  $('mastr-werte').innerHTML =
    `<dt>Standort</dt><dd>${k.adresse ? `${esc(k.adresse.s)} ${esc(k.adresse.n)}, ${esc(k.adresse.p)} Berlin` : 'deine Adresse'}</dd>` +
    `<dt>Modulleistung</dt><dd>${nf(wp)} Wp <span class="klein">(steht auf dem Modul bzw. im Datenblatt)</span></dd>` +
    `<dt>Wechselrichter</dt><dd>höchstens 800 W <span class="klein">(Datenblatt)</span></dd>` +
    `<dt>Inbetriebnahme</dt><dd>der Tag, an dem du den Stecker zum ersten Mal einsteckst</dd>` +
    `<dt>Zählernummer</dt><dd>steht auf deinem Stromzähler</dd>`;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

export function setzeKontext(k) {
  kontext = {...kontext, ...k};
  aktualisiere();
}

export function initSchritte() {
  for (const id of ['mail-name', 'mail-wohnung']) $(id).addEventListener('input', () => aktualisiere());
  $('mail-text').addEventListener('input', () => { bearbeitet = true; $('mail-neu').hidden = false; });
  $('mail-neu').addEventListener('click', () => aktualisiere(true));
  const meldung = $('mail-status');
  $('mail-oeffnen').addEventListener('click', () => {
    const {betreff} = mailText();
    const body = $('mail-text').value.replace(/\r?\n/g, '\r\n');
    location.href = `mailto:?subject=${encodeURIComponent(betreff)}&body=${encodeURIComponent(body)}`;
    meldung.textContent = 'Dein E-Mail-Programm sollte sich jetzt öffnen. Trag dort noch die Adresse deiner Vermieterin oder deines Vermieters ein.';
  });
  $('mail-kopieren').addEventListener('click', async () => {
    const t = `Betreff: ${mailText().betreff}\n\n${$('mail-text').value}`;
    let ok = false;
    try { await navigator.clipboard.writeText(t); ok = true; } catch {
      const ta = $('mail-text'); ta.focus(); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
    }
    meldung.textContent = ok ? 'Text kopiert. Füg ihn in deine E-Mail oder einen Brief ein.' : 'Kopieren hat nicht geklappt. Markier den Text bitte selbst und kopier ihn.';
  });
  aktualisiere();
}
