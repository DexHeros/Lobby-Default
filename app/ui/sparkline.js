// app/ui/sparkline.js
//
// Phase-4 Earnings tab — a tiny canvas-based line chart for earnings
// over time. Pure-DOM, no chart libraries (we already ship plenty).
// Reuses the cyan/blue gradient from the rest of the host UI so the
// chart feels of-a-piece with the hero, system check, and download
// progress bar.
//
// Usage:
//   const sl = buildSparkline({
//       width: 360,
//       height: 80,
//       points: [0, 0.001, 0.003, 0.012, ...],   // y values, evenly spaced
//   });
//   container.appendChild(sl);
//
// Updates: call sl.update(newPoints) any time. The component animates
// the line to the new geometry over ~300ms (cheap requestAnimationFrame
// tween on the path's d attribute via SVG, not canvas — easier crisp
// rendering at any DPR).

const NS = 'http://www.w3.org/2000/svg';

function buildPath(points, w, h, padX = 6, padY = 6) {
    if (!points || points.length === 0) return '';
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min;
    const yScale = (v) => {
        if (span === 0) return h - padY;
        return padY + (h - 2 * padY) * (1 - (v - min) / span);
    };
    const xScale = (i) => {
        if (points.length === 1) return w / 2;
        return padX + (w - 2 * padX) * (i / (points.length - 1));
    };
    let d = `M ${xScale(0).toFixed(2)} ${yScale(points[0]).toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
        d += ` L ${xScale(i).toFixed(2)} ${yScale(points[i]).toFixed(2)}`;
    }
    return d;
}

function buildArea(points, w, h, padX = 6, padY = 6) {
    const path = buildPath(points, w, h, padX, padY);
    if (!path) return '';
    return path + ` L ${w - padX} ${h - padY} L ${padX} ${h - padY} Z`;
}

/**
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number[]} opts.points
 * @param {string} [opts.tooltip] — small caption rendered under the chart
 * @returns {HTMLElement} with .update(points) + .destroy()
 */
export function buildSparkline(opts) {
    const w = opts.width || 360;
    const h = opts.height || 80;

    const wrap = document.createElement('div');
    wrap.className = 'sparkline';
    wrap.style.cssText = `width:${w}px;max-width:100%;`;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(h));
    svg.setAttribute('preserveAspectRatio', 'none');

    // Soft fill under the line.
    const grad = document.createElementNS(NS, 'linearGradient');
    grad.setAttribute('id', `sparkfill-${Math.random().toString(36).slice(2, 9)}`);
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    const stop1 = document.createElementNS(NS, 'stop');
    stop1.setAttribute('offset', '0%');
    stop1.setAttribute('stop-color', 'var(--acc-cyan, #06b6d4)');
    stop1.setAttribute('stop-opacity', '0.45');
    const stop2 = document.createElementNS(NS, 'stop');
    stop2.setAttribute('offset', '100%');
    stop2.setAttribute('stop-color', 'var(--acc-cyan, #06b6d4)');
    stop2.setAttribute('stop-opacity', '0');
    grad.appendChild(stop1);
    grad.appendChild(stop2);
    const defs = document.createElementNS(NS, 'defs');
    defs.appendChild(grad);
    svg.appendChild(defs);

    const area = document.createElementNS(NS, 'path');
    area.setAttribute('fill', `url(#${grad.getAttribute('id')})`);
    area.setAttribute('d', buildArea(opts.points || [], w, h));
    svg.appendChild(area);

    const line = document.createElementNS(NS, 'path');
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'var(--acc-cyan, #06b6d4)');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    line.style.filter = 'drop-shadow(0 0 4px rgba(6,182,212,0.55))';
    line.setAttribute('d', buildPath(opts.points || [], w, h));
    svg.appendChild(line);

    // Last-point dot (the "you are here" indicator).
    const lastDot = document.createElementNS(NS, 'circle');
    lastDot.setAttribute('r', '2.5');
    lastDot.setAttribute('fill', 'var(--acc-cyan, #06b6d4)');
    lastDot.style.filter = 'drop-shadow(0 0 6px rgba(6,182,212,0.85))';
    svg.appendChild(lastDot);

    function positionLastDot(points) {
        if (!points.length) { lastDot.setAttribute('opacity', '0'); return; }
        const last = points[points.length - 1];
        const min = Math.min(...points);
        const max = Math.max(...points);
        const span = max - min;
        const xScale = (i) => 6 + (w - 12) * (points.length === 1 ? 0.5 : (i / (points.length - 1)));
        const yScale = (v) => span === 0 ? h - 6 : 6 + (h - 12) * (1 - (v - min) / span);
        lastDot.setAttribute('cx', String(xScale(points.length - 1)));
        lastDot.setAttribute('cy', String(yScale(last)));
        lastDot.setAttribute('opacity', '1');
    }
    positionLastDot(opts.points || []);

    wrap.appendChild(svg);

    if (opts.tooltip) {
        const cap = document.createElement('div');
        cap.className = 'sparkline-caption';
        cap.style.cssText = `font-family:var(--font-mono,monospace);font-size:10px;color:var(--ink-3,rgba(255,255,255,0.38));margin-top:4px;letter-spacing:0.06em;`;
        cap.textContent = opts.tooltip;
        wrap.appendChild(cap);
    }

    wrap.update = (newPoints) => {
        line.setAttribute('d', buildPath(newPoints, w, h));
        area.setAttribute('d', buildArea(newPoints, w, h));
        positionLastDot(newPoints);
    };

    return wrap;
}
