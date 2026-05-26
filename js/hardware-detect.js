/**
 * Hardware Pre-Flight Detection
 * Detects GPU, VRAM, encoding capability, and upload bandwidth
 * for node operator onboarding. Browser-based (WebGL + performance APIs).
 */

const HardwareDetect = (() => {

    // ── GPU Tier Classification ──────────────────────────────────

    const GPU_TIERS = {
        3: { label: 'High-End', minVram: 12, examples: ['RTX 3080', 'RTX 3090', 'RTX 4070 Ti', 'RTX 4080', 'RTX 4090', 'RX 7800 XT', 'RX 7900'] },
        2: { label: 'Mid-Range', minVram: 8,  examples: ['RTX 3060 Ti', 'RTX 3070', 'RTX 4060', 'RTX 4070', 'RX 6700 XT', 'RX 6800', 'RX 7700 XT'] },
        1: { label: 'Entry',     minVram: 4,  examples: ['GTX 1650', 'GTX 1660', 'RTX 2060', 'RX 6500', 'RX 6600'] },
        0: { label: 'Insufficient', minVram: 0, examples: [] }
    };

    const TIER_PATTERNS = [
        // Tier 3 — high-end (12 GB+ modern flagship)
        { pattern: /RTX\s*(409|408|3090|3080)/i, tier: 3 },
        { pattern: /RX\s*(7900|7800)/i, tier: 3 },
        { pattern: /A100|H100|L40|A6000/i, tier: 3 },
        // Tier 2 — mid-range (8 GB+ modern gaming PC baseline)
        { pattern: /RTX\s*(407|406|3070|306[5-9]|306\s*Ti|2080)/i, tier: 2 },
        { pattern: /RX\s*(6700\s*XT|6700|6800|7600\s*XT|7700)/i, tier: 2 },
        // Tier 1 — entry (below baseline)
        { pattern: /RTX\s*(2070|2060|2050)/i, tier: 1 },
        { pattern: /GTX\s*16[56]0/i, tier: 1 },
        { pattern: /RX\s*(6600|6500|7600)/i, tier: 1 },
        // Tier 0 — integrated / old
        { pattern: /Intel.*(?:UHD|Iris|HD\s*Graphics)/i, tier: 0 },
        { pattern: /Apple.*GPU/i, tier: 0 },
        { pattern: /Mali|Adreno|PowerVR/i, tier: 0 }
    ];

    // Raised gate: high-end rig required (Tier 3 — modern flagship GPU, 12 GB+ VRAM)
    const MIN_TIER     = 3;
    const MIN_VRAM_GB  = 12;
    const MIN_UPLOAD   = 50;   // Mbps sustained
    const MIN_RAM_GB   = 8;    // navigator.deviceMemory caps at 8; the native agent re-verifies the real ceiling (target: 32 GB)
    const MIN_CPU_CORE = 8;

    function detectGPU() {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) {
            return { renderer: 'Unknown', vendor: 'Unknown', tier: 0, tierLabel: 'Insufficient', supported: false };
        }

        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        const vendor = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);

        let tier = 0;
        for (const { pattern, tier: t } of TIER_PATTERNS) {
            if (pattern.test(renderer)) { tier = t; break; }
        }

        canvas.remove();
        return {
            renderer,
            vendor,
            tier,
            tierLabel: GPU_TIERS[tier]?.label || 'Unknown',
            supported: tier >= MIN_TIER
        };
    }

    // ── VRAM Estimation ──────────────────────────────────────────

    function estimateVRAM() {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) {
            canvas.remove();
            return { estimatedGB: 0, method: 'none', supported: false };
        }

        // Try WEBGL_memory_info extension (Chrome)
        const memInfo = gl.getExtension('WEBGL_memory_info');
        if (memInfo) {
            const totalKB = gl.getParameter(memInfo.GPU_MEMORY_INFO_TOTAL_AVAILABLE_MEMORY_NVX);
            if (totalKB) {
                canvas.remove();
                const gb = Math.round(totalKB / 1024 / 1024 * 10) / 10;
                return { estimatedGB: gb, method: 'WEBGL_memory_info', supported: gb >= MIN_VRAM_GB };
            }
        }

        // Fallback: max texture size heuristic
        const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
        let estimatedGB;
        if (maxTexSize >= 16384) estimatedGB = 8;
        else if (maxTexSize >= 8192) estimatedGB = 4;
        else estimatedGB = 2;

        canvas.remove();
        return {
            estimatedGB,
            method: 'texture-heuristic',
            maxTextureSize: maxTexSize,
            maxRenderbufferSize,
            supported: estimatedGB >= MIN_VRAM_GB
        };
    }

    // ── System RAM + CPU cores ───────────────────────────────────

    function detectSystemRam() {
        // navigator.deviceMemory caps at 8 GB per the spec to limit fingerprinting.
        // If we see 8 the machine has >=8 GB; the native host agent verifies the real
        // capacity at install time (target: 32 GB gaming-PC baseline).
        const reported = navigator.deviceMemory;
        if (typeof reported !== 'number' || reported <= 0) {
            return { reportedGB: null, method: 'unsupported', supported: false };
        }
        return {
            reportedGB: reported,
            method: 'navigator.deviceMemory',
            supported: reported >= MIN_RAM_GB
        };
    }

    function detectCpuCores() {
        const cores = navigator.hardwareConcurrency || 0;
        return {
            cores,
            method: 'navigator.hardwareConcurrency',
            supported: cores >= MIN_CPU_CORE
        };
    }

    // ── Upload Bandwidth Test ────────────────────────────────────

    async function testUploadBandwidth(durationSec = 10) {
        const chunkSize = 256 * 1024; // 256 KB chunks
        const payload = new Uint8Array(chunkSize);
        crypto.getRandomValues(payload);
        const blob = new Blob([payload]);

        let totalBytes = 0;
        const start = performance.now();
        const deadline = start + (durationSec * 1000);
        const samples = [];

        while (performance.now() < deadline) {
            const chunkStart = performance.now();
            try {
                const res = await fetch('/api/node/preflight/bandwidth-test', {
                    method: 'POST',
                    body: blob,
                    headers: { 'Content-Type': 'application/octet-stream' }
                });
                if (!res.ok) break;
                const elapsed = (performance.now() - chunkStart) / 1000;
                totalBytes += chunkSize;
                samples.push(chunkSize / elapsed); // bytes/sec
            } catch {
                break;
            }
        }

        const totalElapsed = (performance.now() - start) / 1000;
        const avgBps = totalBytes / totalElapsed;
        const avgMbps = Math.round((avgBps * 8 / 1_000_000) * 10) / 10;

        // Compute p10 and p90 from samples
        samples.sort((a, b) => a - b);
        const p10Mbps = samples.length > 2
            ? Math.round((samples[Math.floor(samples.length * 0.1)] * 8 / 1_000_000) * 10) / 10
            : avgMbps;
        const p90Mbps = samples.length > 2
            ? Math.round((samples[Math.floor(samples.length * 0.9)] * 8 / 1_000_000) * 10) / 10
            : avgMbps;

        return {
            avgMbps,
            p10Mbps,
            p90Mbps,
            totalMB: Math.round(totalBytes / 1_000_000 * 10) / 10,
            durationSec: Math.round(totalElapsed * 10) / 10,
            samples: samples.length,
            supported: avgMbps >= MIN_UPLOAD
        };
    }

    // ── Encoder Detection ────────────────────────────────────────

    async function detectEncoder() {
        const codecs = [
            { name: 'H.264 Hardware', codec: 'avc1.640033', hw: 'prefer-hardware' },
            { name: 'H.265/HEVC Hardware', codec: 'hvc1.1.6.L153.B0', hw: 'prefer-hardware' },
            { name: 'VP9 Hardware', codec: 'vp09.00.50.08', hw: 'prefer-hardware' },
            { name: 'AV1 Hardware', codec: 'av01.0.08M.08', hw: 'prefer-hardware' },
            { name: 'H.264 Software', codec: 'avc1.640033', hw: 'prefer-software' }
        ];

        if (typeof VideoEncoder === 'undefined') {
            return {
                supported: [],
                hardwareAccelerated: false,
                bestCodec: null,
                encoderAvailable: false
            };
        }

        const supported = [];
        let hardwareAccelerated = false;

        for (const { name, codec, hw } of codecs) {
            try {
                const result = await VideoEncoder.isConfigSupported({
                    codec,
                    width: 1920,
                    height: 1080,
                    bitrate: 8_000_000,
                    framerate: 60,
                    hardwareAcceleration: hw
                });
                if (result.supported) {
                    supported.push(name);
                    if (hw === 'prefer-hardware') hardwareAccelerated = true;
                }
            } catch {
                // Codec not supported
            }
        }

        return {
            supported,
            hardwareAccelerated,
            bestCodec: supported[0] || null,
            encoderAvailable: supported.length > 0
        };
    }

    // ── Full Pre-Flight Check ────────────────────────────────────

    async function runPreFlight(options = {}) {
        const bandwidthDuration = options.bandwidthDuration || 10;
        const skipBandwidth = options.skipBandwidth || false;

        const [gpu, vram, encoder] = await Promise.all([
            Promise.resolve(detectGPU()),
            Promise.resolve(estimateVRAM()),
            detectEncoder()
        ]);
        const ram  = detectSystemRam();
        const cpu  = detectCpuCores();

        let bandwidth = null;
        if (!skipBandwidth) {
            bandwidth = await testUploadBandwidth(bandwidthDuration);
        }

        const checks = {
            gpu: {
                pass: gpu.supported,
                value: `${gpu.renderer} (Tier ${gpu.tier}: ${gpu.tierLabel})`,
                requirement: `Discrete GPU, Tier ${MIN_TIER}+ (mid-range or better)`
            },
            vram: {
                pass: vram.supported,
                value: `~${vram.estimatedGB} GB (${vram.method})`,
                requirement: `${MIN_VRAM_GB} GB minimum`
            },
            ram: {
                pass: ram.supported,
                value: ram.reportedGB != null ? `${ram.reportedGB}+ GB detected` : 'Unable to detect',
                requirement: '32 GB system memory (agent verifies full capacity at install)'
            },
            cpu: {
                pass: cpu.supported,
                value: cpu.cores ? `${cpu.cores} logical cores` : 'Unable to detect',
                requirement: `${MIN_CPU_CORE}+ logical cores`
            },
            encoder: {
                pass: encoder.encoderAvailable && encoder.hardwareAccelerated,
                value: encoder.bestCodec
                    ? `${encoder.bestCodec}${encoder.hardwareAccelerated ? ' (HW accelerated)' : ' (software only)'}`
                    : 'None detected',
                requirement: 'Hardware-accelerated H.264 or HEVC',
                hardwareAccelerated: encoder.hardwareAccelerated
            }
        };

        if (bandwidth) {
            checks.upload = {
                pass: bandwidth.supported,
                value: `${bandwidth.avgMbps} Mbps (sustained ${bandwidth.durationSec}s)`,
                requirement: `${MIN_UPLOAD} Mbps minimum, wired connection`
            };
        }

        const allPass = Object.values(checks).every(c => c.pass);
        const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

        return {
            checks,
            allPass: allPass && !isMobile,
            isMobile,
            gpu,
            vram,
            ram,
            cpu,
            encoder,
            bandwidth,
            timestamp: new Date().toISOString()
        };
    }

    return {
        detectGPU,
        estimateVRAM,
        detectSystemRam,
        detectCpuCores,
        testUploadBandwidth,
        detectEncoder,
        runPreFlight,
        GPU_TIERS,
        REQUIREMENTS: { MIN_TIER, MIN_VRAM_GB, MIN_UPLOAD, MIN_RAM_GB, MIN_CPU_CORE }
    };
})();

window.HardwareDetect = HardwareDetect;
