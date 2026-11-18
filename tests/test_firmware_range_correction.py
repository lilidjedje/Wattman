"""Run the firmware's actual range function on the host, without hardware."""
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest


class FirmwareRangeCorrectionTests(unittest.TestCase):
    def test_transfer_function(self):
        compiler = shutil.which('g++')
        if not compiler:
            self.skipTest('g++ is required for the firmware host check')
        firmware = pathlib.Path(__file__).resolve().parents[1] / 'can_server/esp32C3-multi-INA226-copie/esp32C3-multi-INA226-copie.ino'
        source = firmware.read_text(encoding='utf-8')
        start = source.index('struct RangePoint ')
        end = source.index('constexpr uint32_t INA_PROFILE_FREQ', start)
        harness = r'''
#include <cmath>
#include <cstdint>
#include <cstddef>
#include <cassert>
#include <initializer_list>
''' + source[start:end] + r'''
int main() {
    // The same filter behaves identically for A and B, with independent state.
    for (uint32_t frequency : {100u, 400u, 1000u, 2000u}) {
        resetCurrentFilter(0, frequency);
        resetCurrentFilter(1, frequency);
        for (int n = 0; n < 500; ++n) {
            float input = n % 11 == 0 ? 4.0f : 1.0f;
            assert(filterCurrent(0, input) == filterCurrent(1, input));
        }
        resetCurrentFilter(0, frequency);
        resetCurrentFilter(1, frequency);
        for (int n = 0; n < 100; ++n) {
            assert(filterCurrent(0, 1.0f) == 1.0f);
            assert(filterCurrent(1, 2.0f) == 2.0f);
        }
        resetCurrentFilter(0, frequency);
        assert(filterCurrent(1, 2.0f) == 2.0f);
    }
    // All protected low-range inputs retain the exact v11 factor.
    for (int n = 0; n <= 12000; ++n) {
        float x = n / 10000.0f;
        assert(rangeCorrection(0, x) == 1.031848f);
        assert(rangeCorrection(0, -x) == 1.031848f);
    }
    // Replay every checkpoint from the supplied CSV, removing v11's factor.
    const double shown[] = {2.574052,2.574081,2.574068,2.574030,2.574059,2.574053,2.574114};
    double sum = 0;
    for (double y : shown) {
        float x = y / 1.031848;
        double corrected = x * rangeCorrection(0, x);
        assert(std::abs(corrected - 2.213300) < 0.0001);
        sum += corrected;
    }
    assert(std::abs(sum / 7 - 2.213300) < 0.00001);
    // No reversals or jumps at the anchors; B is never corrected.
    float previous = 0;
    for (int n = 1; n <= 100000; ++n) {
        float x = n / 10000.0f;
        float y = x * rangeCorrection(0, x);
        assert(y >= previous);
        assert(y - previous < 0.0002f);
        assert(rangeCorrection(0, -x) == rangeCorrection(0, x));
        assert(rangeCorrection(1, x) == 1.0f);
        previous = y;
    }
}
'''
        with tempfile.TemporaryDirectory() as folder:
            cpp = pathlib.Path(folder) / 'range.cpp'
            exe = pathlib.Path(folder) / 'range.exe'
            cpp.write_text(harness, encoding='utf-8')
            subprocess.run([compiler, '-std=c++11', str(cpp), '-o', str(exe)], check=True, capture_output=True)
            subprocess.run([str(exe)], check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
