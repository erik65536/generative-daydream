/** Procedural icons for skills and items (used when no generated icon exists). */
import { rx, type DamageEffect } from '@gd/shared';
import { kindColor, rules } from '../rules';
import { hexToRgb, rgb, shade } from './color';

function frame(ctx: CanvasRenderingContext2D, s: number, color: string) {
  const c = hexToRgb(color);
  const g = ctx.createRadialGradient(s * 0.5, s * 0.35, 2, s * 0.5, s * 0.5, s * 0.7);
  g.addColorStop(0, rgb(shade(c, 0.75)));
  g.addColorStop(1, rgb(shade(c, 0.22)));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(1, 1, s - 2, s - 2, s * 0.16);
  ctx.fill();
  ctx.strokeStyle = rgb(shade(c, 1.3), 0.6);
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

export function drawSkillIcon(ctx: CanvasRenderingContext2D, s: number, skillId: string) {
  ctx.clearRect(0, 0, s, s);
  const rs = rules();
  const sk = rs ? rx(rs).skill.get(skillId) : undefined;
  if (!sk || !rs) return;
  const dmg = sk.effects.find((e) => e.kind === 'damage') as DamageEffect | undefined;
  const heals = sk.effects.some((e) => e.kind === 'heal' || e.kind === 'barrier' || e.kind === 'revive');
  const status = sk.effects.find((e) => e.kind === 'status') as { statusId: string } | undefined;
  const elem = dmg ? kindColor(dmg.subtypeId === '$family' ? undefined : dmg.subtypeId ?? (dmg.weapon ? undefined : dmg.typeId), '#e8d8b0') : heals ? '#7dff9a' : status ? kindColor(status.statusId, '#c9a6ff') : '#e8d8b0';
  const frameColor = sk.tags.includes('weapon') || sk.tags.includes('basic') ? '#c8a060' : heals ? '#5ac0a8' : '#8a7ab8';
  frame(ctx, s, frameColor);
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.strokeStyle = '#fff6dc';
  ctx.fillStyle = elem;
  ctx.lineWidth = s * 0.07;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = elem;
  ctx.shadowBlur = s * 0.25;
  const r = s * 0.3;
  if (sk.tags.includes('basic')) {
    ctx.rotate(-0.8);
    ctx.beginPath();
    ctx.moveTo(0, r * 1.1);
    ctx.lineTo(0, -r * 1.1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-r * 0.45, r * 0.55);
    ctx.lineTo(r * 0.45, r * 0.55);
    ctx.stroke();
  } else if (sk.utility) {
    ctx.beginPath();
    ctx.arc(-r * 0.3, -r * 0.3, r * 0.45, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(r, r);
    ctx.lineTo(r * 0.6, r);
    ctx.stroke();
  } else if (sk.fx === 'none') {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 4) / 5;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.stroke();
  } else
    switch (sk.fx) {
      case 'slash':
        ctx.beginPath();
        ctx.arc(-r * 0.4, r * 0.4, r * 1.2, -Math.PI * 0.45, -Math.PI * 0.05);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(-r * 0.1, r * 0.1, r * 0.9, -Math.PI * 0.42, -Math.PI * 0.08);
        ctx.stroke();
        break;
      case 'arrow':
        ctx.rotate(-0.78);
        ctx.beginPath();
        ctx.moveTo(0, r * 1.1);
        ctx.lineTo(0, -r * 1.1);
        ctx.moveTo(-r * 0.35, -r * 0.7);
        ctx.lineTo(0, -r * 1.1);
        ctx.lineTo(r * 0.35, -r * 0.7);
        ctx.stroke();
        break;
      case 'bolt':
        ctx.beginPath();
        ctx.arc(r * 0.25, -r * 0.25, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-r, r);
        ctx.lineTo(-r * 0.1, r * 0.1);
        ctx.stroke();
        break;
      case 'beam':
        ctx.beginPath();
        ctx.moveTo(-r * 0.2, -r * 1.1);
        ctx.lineTo(r * 0.3, -r * 0.1);
        ctx.lineTo(-r * 0.25, 0);
        ctx.lineTo(r * 0.2, r * 1.1);
        ctx.stroke();
        break;
      case 'nova':
        for (let i = 1; i <= 3; i++) {
          ctx.globalAlpha = 1 - i * 0.22;
          ctx.beginPath();
          ctx.arc(0, 0, (r * i) / 2.4, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      case 'heal':
        ctx.fillStyle = '#9dffbf';
        ctx.shadowColor = '#9dffbf';
        ctx.fillRect(-r * 0.22, -r * 0.8, r * 0.44, r * 1.6);
        ctx.fillRect(-r * 0.8, -r * 0.22, r * 1.6, r * 0.44);
        break;
      case 'buff':
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.7, 0);
        ctx.lineTo(r * 0.25, 0);
        ctx.lineTo(r * 0.25, r);
        ctx.lineTo(-r * 0.25, r);
        ctx.lineTo(-r * 0.25, 0);
        ctx.lineTo(-r * 0.7, 0);
        ctx.closePath();
        ctx.stroke();
        break;
      case 'debuff':
        ctx.beginPath();
        ctx.moveTo(0, r);
        ctx.lineTo(r * 0.7, 0);
        ctx.lineTo(r * 0.25, 0);
        ctx.lineTo(r * 0.25, -r);
        ctx.lineTo(-r * 0.25, -r);
        ctx.lineTo(-r * 0.25, 0);
        ctx.lineTo(-r * 0.7, 0);
        ctx.closePath();
        ctx.stroke();
        break;
      case 'shadow':
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.9, Math.PI * 0.2, Math.PI * 1.8);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(r * 0.35, 0, r * 0.55, Math.PI * 0.5, Math.PI * 1.5);
        ctx.stroke();
        break;
      case 'cloud':
        ctx.globalAlpha = 0.85;
        for (const [x, y, rr] of [[-0.4, 0.1, 0.45], [0.1, -0.2, 0.55], [0.5, 0.15, 0.4]] as const) {
          ctx.beginPath();
          ctx.arc(x * r, y * r, rr * r, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      default:
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
        ctx.stroke();
    }
  ctx.restore();
}

export function drawItemIcon(ctx: CanvasRenderingContext2D, s: number, item: { baseId: string; rarityId?: string }) {
  ctx.clearRect(0, 0, s, s);
  const rs = rules();
  const base = rs ? rx(rs).item.get(item.baseId) : undefined;
  const icon = base?.icon ?? 'quest';
  const rc = (rs && item.rarityId ? rx(rs).rarity.get(item.rarityId)?.color : undefined) ?? '#ccc';
  const element = base?.weapon?.subtypeId ?? base?.weapon?.typeId;
  ctx.save();
  ctx.translate(s / 2, s / 2);
  const r = s * 0.34;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const metal = '#d6dbe4', wood = '#7a5232', leather = '#8a5a34', cloth = '#6a5a8a';
  const stroke = (c: string, w: number) => {
    ctx.strokeStyle = c;
    ctx.lineWidth = w;
  };
  switch (icon) {
    case 'sword':
      ctx.rotate(-0.78);
      ctx.fillStyle = metal;
      ctx.beginPath();
      ctx.moveTo(-r * 0.12, r * 0.4);
      ctx.lineTo(-r * 0.1, -r * 1.05);
      ctx.lineTo(0, -r * 1.25);
      ctx.lineTo(r * 0.1, -r * 1.05);
      ctx.lineTo(r * 0.12, r * 0.4);
      ctx.fill();
      ctx.fillStyle = rc;
      ctx.fillRect(-r * 0.45, r * 0.38, r * 0.9, r * 0.14);
      ctx.fillStyle = leather;
      ctx.fillRect(-r * 0.08, r * 0.52, r * 0.16, r * 0.5);
      break;
    case 'axe':
      ctx.rotate(-0.6);
      stroke(wood, s * 0.08);
      ctx.beginPath();
      ctx.moveTo(0, r * 1.1);
      ctx.lineTo(0, -r * 1.1);
      ctx.stroke();
      ctx.fillStyle = metal;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.quadraticCurveTo(r * 1.1, -r * 1.1, r * 0.9, -r * 0.1);
      ctx.lineTo(0, -r * 0.35);
      ctx.fill();
      break;
    case 'dagger':
      ctx.rotate(-0.78);
      ctx.fillStyle = metal;
      ctx.beginPath();
      ctx.moveTo(-r * 0.14, r * 0.2);
      ctx.lineTo(0, -r * 0.9);
      ctx.lineTo(r * 0.14, r * 0.2);
      ctx.fill();
      ctx.fillStyle = rc;
      ctx.fillRect(-r * 0.32, r * 0.2, r * 0.64, r * 0.12);
      ctx.fillStyle = leather;
      ctx.fillRect(-r * 0.07, r * 0.32, r * 0.14, r * 0.45);
      break;
    case 'bow':
      stroke(wood, s * 0.08);
      ctx.beginPath();
      ctx.arc(-r * 0.5, 0, r * 1.1, -1.1, 1.1);
      ctx.stroke();
      stroke('#e8e0d0', 1);
      ctx.beginPath();
      ctx.moveTo(-r * 0.5 + Math.cos(-1.1) * r * 1.1, Math.sin(-1.1) * r * 1.1);
      ctx.lineTo(-r * 0.5 + Math.cos(1.1) * r * 1.1, Math.sin(1.1) * r * 1.1);
      ctx.stroke();
      break;
    case 'staff':
    case 'wand': {
      ctx.rotate(-0.6);
      stroke(wood, s * (icon === 'staff' ? 0.08 : 0.06));
      ctx.beginPath();
      ctx.moveTo(0, r * 1.1);
      ctx.lineTo(0, -r * (icon === 'staff' ? 0.9 : 0.5));
      ctx.stroke();
      const ec = kindColor(element, '#8ad');
      ctx.shadowColor = ec;
      ctx.shadowBlur = 8;
      ctx.fillStyle = ec;
      ctx.beginPath();
      ctx.arc(0, -r * (icon === 'staff' ? 1.05 : 0.65), r * 0.24, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'shield':
      ctx.fillStyle = metal;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.85, -r * 0.7);
      ctx.quadraticCurveTo(r * 0.8, r * 0.6, 0, r * 1.05);
      ctx.quadraticCurveTo(-r * 0.8, r * 0.6, -r * 0.85, -r * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = rc;
      ctx.beginPath();
      ctx.arc(0, -r * 0.1, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'book':
      ctx.fillStyle = '#6a3a2a';
      ctx.fillRect(-r * 0.75, -r * 0.9, r * 1.5, r * 1.8);
      ctx.fillStyle = '#e8dcc0';
      ctx.fillRect(-r * 0.6, -r * 0.78, r * 1.25, r * 1.56);
      ctx.fillStyle = rc;
      ctx.fillRect(-r * 0.75, -r * 0.9, r * 0.2, r * 1.8);
      break;
    case 'helm':
    case 'hood':
      ctx.fillStyle = icon === 'helm' ? metal : cloth;
      ctx.beginPath();
      ctx.arc(0, r * 0.1, r * 0.8, Math.PI, 0);
      ctx.lineTo(r * 0.8, r * 0.6);
      ctx.lineTo(-r * 0.8, r * 0.6);
      ctx.closePath();
      ctx.fill();
      if (icon === 'helm') {
        ctx.fillStyle = '#222';
        ctx.fillRect(-r * 0.5, r * 0.05, r, r * 0.18);
      }
      break;
    case 'chest':
    case 'robe':
      ctx.fillStyle = icon === 'chest' ? metal : cloth;
      ctx.beginPath();
      ctx.moveTo(-r * 0.9, -r * 0.6);
      ctx.lineTo(-r * 0.4, -r * 0.9);
      ctx.lineTo(r * 0.4, -r * 0.9);
      ctx.lineTo(r * 0.9, -r * 0.6);
      ctx.lineTo(r * 0.6, -r * 0.2);
      ctx.lineTo(r * 0.6, r * (icon === 'robe' ? 1.1 : 0.8));
      ctx.lineTo(-r * 0.6, r * (icon === 'robe' ? 1.1 : 0.8));
      ctx.lineTo(-r * 0.6, -r * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = rc;
      ctx.fillRect(-r * 0.6, r * 0.2, r * 1.2, r * 0.12);
      break;
    case 'gloves':
      ctx.fillStyle = leather;
      ctx.beginPath();
      ctx.roundRect(-r * 0.5, -r * 0.6, r, r * 1.2, r * 0.3);
      ctx.fill();
      ctx.fillRect(-r * 0.75, -r * 0.2, r * 0.3, r * 0.5);
      break;
    case 'boots':
      ctx.fillStyle = leather;
      ctx.beginPath();
      ctx.moveTo(-r * 0.4, -r * 0.9);
      ctx.lineTo(r * 0.2, -r * 0.9);
      ctx.lineTo(r * 0.2, r * 0.3);
      ctx.lineTo(r * 0.9, r * 0.5);
      ctx.lineTo(r * 0.9, r * 0.9);
      ctx.lineTo(-r * 0.4, r * 0.9);
      ctx.closePath();
      ctx.fill();
      break;
    case 'ring':
      stroke('#f0c860', s * 0.09);
      ctx.beginPath();
      ctx.arc(0, r * 0.15, r * 0.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = rc;
      ctx.beginPath();
      ctx.arc(0, -r * 0.5, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'amulet':
      stroke('#d0b060', 1.5);
      ctx.beginPath();
      ctx.arc(0, -r * 0.3, r * 0.75, Math.PI * 0.1, Math.PI * 0.9, true);
      ctx.stroke();
      ctx.fillStyle = rc;
      ctx.beginPath();
      ctx.moveTo(0, r * 0.1);
      ctx.lineTo(r * 0.38, r * 0.5);
      ctx.lineTo(0, r * 0.95);
      ctx.lineTo(-r * 0.38, r * 0.5);
      ctx.closePath();
      ctx.fill();
      break;
    case 'potion_red':
    case 'potion_green':
    case 'potion_blue':
    case 'potion_white':
    case 'potion_orange': {
      const col = ({ potion_red: '#e0304a', potion_green: '#5ad040', potion_blue: '#4a8ae8', potion_white: '#e8e8f0', potion_orange: '#f09a30' } as Record<string, string>)[icon] ?? '#e0304a';
      ctx.fillStyle = 'rgba(220,230,240,0.35)';
      ctx.beginPath();
      ctx.arc(0, r * 0.25, r * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(0, r * 0.3, r * 0.58, 0.15, Math.PI - 0.15);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(220,230,240,0.55)';
      ctx.fillRect(-r * 0.2, -r * 0.8, r * 0.4, r * 0.55);
      ctx.fillStyle = wood;
      ctx.fillRect(-r * 0.24, -r * 1.0, r * 0.48, r * 0.25);
      break;
    }
    case 'bomb':
    case 'bomb_blue':
      ctx.fillStyle = icon === 'bomb' ? '#3a3236' : '#3a4a6a';
      ctx.beginPath();
      ctx.arc(0, r * 0.2, r * 0.75, 0, Math.PI * 2);
      ctx.fill();
      stroke('#c09050', 2);
      ctx.beginPath();
      ctx.moveTo(r * 0.3, -r * 0.45);
      ctx.quadraticCurveTo(r * 0.6, -r * 1, r * 0.9, -r * 0.8);
      ctx.stroke();
      ctx.fillStyle = icon === 'bomb' ? '#ffb040' : '#9fe0ff';
      ctx.beginPath();
      ctx.arc(r * 0.9, -r * 0.82, r * 0.16, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'scroll':
      ctx.fillStyle = '#e8dcbc';
      ctx.fillRect(-r * 0.7, -r * 0.6, r * 1.4, r * 1.2);
      ctx.fillStyle = '#c8b890';
      ctx.beginPath();
      ctx.arc(-r * 0.7, 0, r * 0.2, 0, Math.PI * 2);
      ctx.arc(r * 0.7, 0, r * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#a03030';
      ctx.beginPath();
      ctx.arc(0, r * 0.4, r * 0.18, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'food':
      ctx.fillStyle = '#c89048';
      ctx.beginPath();
      ctx.ellipse(0, r * 0.1, r * 0.85, r * 0.55, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e8c070';
      ctx.beginPath();
      ctx.ellipse(-r * 0.1, -r * 0.05, r * 0.6, r * 0.3, -0.3, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'tools':
    case 'lockpick':
      stroke(metal, s * 0.06);
      ctx.beginPath();
      ctx.moveTo(-r * 0.8, r * 0.8);
      ctx.lineTo(r * 0.6, -r * 0.6);
      ctx.moveTo(r * 0.6, -r * 0.6);
      ctx.lineTo(r * 0.85, -r * 0.4);
      ctx.stroke();
      if (icon === 'tools') {
        ctx.beginPath();
        ctx.moveTo(r * 0.8, r * 0.8);
        ctx.lineTo(-r * 0.6, -r * 0.6);
        ctx.stroke();
      }
      break;
    case 'herb':
      ctx.fillStyle = '#5ab040';
      for (let i = 0; i < 3; i++) {
        ctx.save();
        ctx.rotate(-0.6 + i * 0.6);
        ctx.beginPath();
        ctx.ellipse(0, -r * 0.45, r * 0.25, r * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      break;
    case 'ore':
    case 'gem':
    case 'crystal':
    case 'essence': {
      const col = icon === 'ore' ? '#8a8a96' : icon === 'gem' ? '#e04a7a' : icon === 'crystal' ? '#8ad8ff' : '#c080ff';
      ctx.fillStyle = col;
      ctx.shadowColor = icon === 'ore' ? 'transparent' : col;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.75, -r * 0.2);
      ctx.lineTo(r * 0.45, r * 0.85);
      ctx.lineTo(-r * 0.45, r * 0.85);
      ctx.lineTo(-r * 0.75, -r * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.3, -r * 0.2);
      ctx.lineTo(-r * 0.3, -r * 0.2);
      ctx.fill();
      break;
    }
    case 'hide':
    case 'cloth':
      ctx.fillStyle = icon === 'hide' ? '#9a6a40' : '#8a7ab0';
      ctx.beginPath();
      ctx.moveTo(-r * 0.8, -r * 0.6);
      ctx.quadraticCurveTo(0, -r * 0.9, r * 0.8, -r * 0.6);
      ctx.quadraticCurveTo(r * 1, r * 0.2, r * 0.6, r * 0.8);
      ctx.quadraticCurveTo(0, r * 0.6, -r * 0.6, r * 0.8);
      ctx.quadraticCurveTo(-r, r * 0.2, -r * 0.8, -r * 0.6);
      ctx.fill();
      break;
    case 'key':
      stroke('#f0c860', s * 0.08);
      ctx.beginPath();
      ctx.arc(-r * 0.4, 0, r * 0.35, 0, Math.PI * 2);
      ctx.moveTo(-r * 0.05, 0);
      ctx.lineTo(r * 0.9, 0);
      ctx.moveTo(r * 0.6, 0);
      ctx.lineTo(r * 0.6, r * 0.35);
      ctx.stroke();
      break;
    default:
      // Quest item: glowing relic
      ctx.fillStyle = '#ffd24a';
      ctx.shadowColor = '#ffd24a';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const rr = i % 2 ? r * 0.45 : r * 0.95;
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
  }
  ctx.restore();
}
