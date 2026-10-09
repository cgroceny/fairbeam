// Regression checks for the production helper in the pinned native patch.
// GPL-3.0-or-later.
#include "conducting_sheet_periodic_topology.h"
#include <cstdlib>
#include <iostream>
#include <vector>

namespace Topology = ConductingSheetPeriodicTopology;

void require(bool value, const char* message)
{
    if (!value) {
        std::cerr << "FAIL: " << message << '\n';
        std::exit(1);
    }
}

void checkOptIn()
{
    require(!Topology::Enabled(NULL, true, 6), "unset flag is legacy");
    require(!Topology::Enabled("", true, 6), "empty flag is legacy");
    require(!Topology::Enabled("1", true, 6), "unknown value is legacy");
    require(!Topology::Enabled("periodic", false, 6), "Cartesian and open wedges are legacy");
    require(!Topology::Enabled("periodic", true, 3), "incomplete angular grid is rejected");
    require(Topology::Enabled("periodic", true, 4), "smallest complete closed grid is enabled");
    require(!Topology::Enabled("periodic", true, 6, false), "ordinary-cylinder multigrid clones stay legacy");
}

void checkRing(unsigned int cells)
{
    const unsigned int lines = cells + 2;
    std::vector<unsigned int> visits(cells, 0);
    for (unsigned int node = 0; node <= cells; ++node) {
        require(!Topology::BoundaryBlocked(1, node, lines, 0, 0, true), "seam is not a physical wall");
        const unsigned int previous = Topology::Previous(1, node, lines, true);
        require(previous < cells, "predecessor never reaches a ghost or underflows");
        const unsigned int physical = Topology::PrimitiveAlpha(node, lines, true);
        require(physical < cells, "duplicate seam queries canonical physical primitives");
        require((previous + 1) % cells == physical, "periodic predecessor is a geometric neighbor");
        if (node < cells)
            ++visits[previous];
    }
    for (unsigned int count : visits)
        require(count == 1, "each physical neighbor is visited once around a ring");
    require(Topology::BoundaryBlocked(1, cells + 1, lines, 0, 0, true), "final ghost stays disabled");

    // An actual gap at the seam must still create two sheet endpoints.
    std::vector<bool> sheet(cells, true);
    unsigned int endpoints = 0;
    sheet[cells - 1] = false;
    for (unsigned int node = 0; node < cells; ++node) {
        const unsigned int previous = Topology::Previous(1, node, lines, true);
        if (sheet[node] != sheet[previous])
            ++endpoints;
    }
    require(endpoints == 2, "real sheet edges are preserved when a gap crosses the seam");
}

void checkPhysicalBoundaries()
{
    for (unsigned int direction = 0; direction < 3; ++direction) {
        for (unsigned int lower = 0; lower < 3; ++lower) {
            for (unsigned int upper = 0; upper < 3; ++upper) {
                for (unsigned int node = 0; node < 12; ++node) {
                    const bool wall = node < lower + 1 || node + upper + 1 >= 12;
                    require(Topology::BoundaryBlocked(direction, node, 12, lower, upper, false) == wall,
                        "flag-off boundary widths are unchanged");
                    if (direction != 1)
                        require(Topology::BoundaryBlocked(direction, node, 12, lower, upper, true) == wall,
                            "radial and axial physical boundaries remain active");
                }
            }
        }
        for (unsigned int node = 1; node < 10; ++node)
            require(Topology::Previous(direction, node, 12, false) + 1 == node,
                "flag-off nonperiodic neighbor is unchanged");
    }
    for (unsigned int node = 0; node < 12; ++node)
        require(Topology::PrimitiveAlpha(node, 12, false) == node, "flag-off primitive query is unchanged");
}

int main()
{
    checkOptIn();
    for (unsigned int cells : {2u, 4u, 8u, 16u, 31u})
        checkRing(cells);
    checkPhysicalBoundaries();
    std::cout << "PASS: opt-in, periodic neighbors, real gaps, ghosts, physical walls, legacy controls\n";
}
