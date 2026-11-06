// Excitation metadata and waveform regression; no Operator, Engine or fields.
#include "FDTD/excitation.h"
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#endif

int main(int argc, char** argv) {
    if (argc != 2 || std::string(argv[1]) != "metadata-only-no-fields") return 2;
    unsigned failures = 0;
    bool first = true;
    std::cout << std::setprecision(17) << "{\"rows\":[";
    for (const std::string mode : {"custom", "sinusoidal"}) {
        std::vector<FDTD_FLOAT> reference_v, reference_i;
        for (const double seed : {0.0, 1.0e8, 1.0e300}) {
            Excitation source;
            // Initialize every queried field through public methods, including
            // the deliberately large prior cutoff. No uninitialized read is used.
            source.SetupGaussianPulse(1.0e6, seed);
            if (mode == "custom") source.SetupCustomExcite("sin(2*pi*1000000*t)", 3.0e6, 3.0e6);
            else source.SetupSinusoidal(3.0e6);
            source.Reset(1.0e-9);  // The operator resets its sampling clock too.
            const double center = source.GetCenterFreq(), cutoff = source.GetCutOffFreq();
            const bool metadata_ok = center == 3.0e6 && cutoff == 0.0;
            if (!source.buildExcitationSignal(128) || source.GetLength() == 0) return 3;
            const auto count = source.GetLength();
            const auto v = source.GetVoltageSignal(), i = source.GetCurrentSignal();
            bool finite = true;
            for (unsigned n = 0; n < count; ++n)
                finite = finite && std::isfinite(v[n]) && std::isfinite(i[n]);
            if (reference_v.empty()) {
                reference_v.assign(v, v + count);
                reference_i.assign(i, i + count);
            }
            const bool signal_equal = reference_v.size() == count && reference_i.size() == count
                && std::equal(reference_v.begin(), reference_v.end(), v)
                && std::equal(reference_i.begin(), reference_i.end(), i);
            if (!metadata_ok || !finite || !signal_equal) ++failures;
            if (!first) std::cout << ',';
            first = false;
            std::cout << "{\"mode\":" << std::quoted(mode)
                << ",\"prior_gaussian_cutoff_hz\":" << seed
                << ",\"center_hz\":" << center << ",\"cutoff_hz\":" << cutoff
                << ",\"rlc_input_frequency_hz\":" << center + cutoff
                << ",\"samples\":" << count
                << ",\"finite_waveforms\":" << (finite ? "true" : "false")
                << ",\"history_independent_waveforms\":" << (signal_equal ? "true" : "false") << '}';
        }
    }
    Excitation gaussian;
    gaussian.SetupGaussianPulse(2.0e6, 1.0e6);
    gaussian.Reset(1.0e-9);
    const bool gaussian_ok = gaussian.GetCenterFreq() == 2.0e6 && gaussian.GetCutOffFreq() == 1.0e6;
    if (!gaussian_ok) ++failures;
    std::string module;
#ifdef _WIN32
    const auto handle = GetModuleHandleA("openEMS.dll");
    char filename[32768] = {};
    if (!handle || !GetModuleFileNameA(handle, filename, sizeof(filename))) return 4;
    module = filename;
#endif
    std::cout << "],\"gaussian_metadata_preserved\":" << (gaussian_ok ? "true" : "false")
        << ",\"native_dll_path\":" << std::quoted(module)
        << ",\"failures\":" << failures
        << ",\"native_operator_setups\":0,\"native_field_runs\":0}" << std::endl;
    return failures ? 1 : 0;
}
