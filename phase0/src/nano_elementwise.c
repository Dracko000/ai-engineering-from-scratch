/* nano_elementwise.c — transformer elementwise ops in scalar C.
 *
 * Companion to ternary_avx2.c. The GEMV there is the bandwidth-bound ternary
 * math; these are the O(hidden) and O(seq) ops that sit *between* the GEMMs
 * (RMSNorm, SwiGLU gate, RoPE, softmax). They are cheap in FLOPs but expensive
 * in per-call NumPy/Python overhead on the single-token decode path, so porting
 * them to C removes that overhead without touching the numerics.
 *
 * Semantics deliberately match the NumPy reference in run_smollm2.py so their
 * outputs are comparable element for element:
 *   rms_norm(x, w)            = x / sqrt(mean(x^2) + eps) * w
 *   silu(g) * up              = g / (1 + exp(-clip(g, -20, 20))) * up
 *   apply_rope(x, cos, sin)   = rotate each head's two halves
 *   softmax(scores, axis=1)   = per (kv, group) normalisation over seq
 *
 * Sources: Zhang & Sennrich, "Root Mean Square Layer Normalization"
 * (arXiv:1910.07467); Su et al., "RoFormer: Enhanced Transformer with Rotary
 * Position Embedding" (arXiv:2104.09864); Hendrycks & Gimpel, "Gaussian Error
 * Linear Units" (arXiv:1606.08415) for the SiLU/Swish form.
 */
#include <math.h>
#include <stddef.h>

#include "ternary_gemm.h"

void nano_rmsnorm_f32(float *out, const float *x, const float *w, int n, float eps) {
    /* Sum of squares in double so the reduction is stable for long rows. */
    double ss = 0.0;
    for (int i = 0; i < n; i++) {
        double v = (double)x[i];
        ss += v * v;
    }
    float rms = (float)sqrt(ss / (double)n + (double)eps);
    for (int i = 0; i < n; i++) {
        out[i] = (x[i] / rms) * w[i];
    }
}

void nano_silu_mul_f32(float *out, const float *gate, const float *up, int n) {
    for (int i = 0; i < n; i++) {
        float g = gate[i];
        /* Clip matches the NumPy reference's exp(-clip(g, -20, 20)). */
        float c = g < -20.0f ? -20.0f : (g > 20.0f ? 20.0f : g);
        float s = g * (1.0f / (1.0f + expf(-c)));
        out[i] = s * up[i];
    }
}

void nano_rope_f32(float *x, const float *cos, const float *sin,
                   int n_heads, int head_dim) {
    int half = head_dim / 2;
    for (int h = 0; h < n_heads; h++) {
        float *base = x + (size_t)h * (size_t)head_dim;
        for (int i = 0; i < half; i++) {
            float a = base[i];            /* first-half component */
            float b = base[i + half];     /* second-half component */
            float c = cos[i];
            float s = sin[i];
            base[i] = a * c - b * s;
            base[i + half] = b * c + a * s;
        }
    }
}

void nano_softmax_axis1_f32(float *x, int axis0, int n, int axis2) {
    /* x is C-contiguous (axis0, n, axis2); normalise over the middle axis. */
    for (int a = 0; a < axis0; a++) {
        for (int g = 0; g < axis2; g++) {
            float *base = x + ((size_t)a * (size_t)n) * (size_t)axis2 + (size_t)g;
            float m = base[0];
            for (int i = 1; i < n; i++) {
                float v = base[(size_t)i * (size_t)axis2];
                if (v > m) m = v;
            }
            double sum = 0.0;
            for (int i = 0; i < n; i++) {
                float e = expf(base[(size_t)i * (size_t)axis2] - m);
                base[(size_t)i * (size_t)axis2] = e;
                sum += (double)e;
            }
            float inv = (float)(1.0 / sum);
            for (int i = 0; i < n; i++) {
                base[(size_t)i * (size_t)axis2] *= inv;
            }
        }
    }
}
