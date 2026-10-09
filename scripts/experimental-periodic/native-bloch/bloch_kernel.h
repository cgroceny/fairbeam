// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental algebra kernel; not an openEMS engine or a physical-validation result.
#ifndef FAIRBEAM_EXPERIMENTAL_BLOCH_KERNEL_H
#define FAIRBEAM_EXPERIMENTAL_BLOCH_KERNEL_H

#include <array>
#include <cmath>
#include <cstddef>
#include <limits>
#include <stdexcept>
#include <vector>

namespace fairbeam_bloch {

// Quadratures of a complex time-domain field, not a Fourier spectrum.
struct Pair {
    double real = 0;
    double imag = 0;
};
inline Pair operator+(Pair a, Pair b) { return {a.real+b.real, a.imag+b.imag}; }
inline Pair operator-(Pair a, Pair b) { return {a.real-b.real, a.imag-b.imag}; }
inline Pair operator*(double a, Pair b) { return {a*b.real, a*b.imag}; }
inline Pair rotate(Pair a, double cosine, double sine) {
    return {cosine*a.real-sine*a.imag, sine*a.real+cosine*a.imag};
}

struct Grid {
    std::array<std::size_t, 3> lines;
    std::array<double, 2> phase_rad;
    std::array<double, 2> cosine;
    std::array<double, 2> sine;
    std::size_t count = 3;

    // x/y have duplicated high endpoints; z has ordinary finite-domain endpoints.
    Grid(std::array<std::size_t, 3> shape, std::array<double, 2> phase)
        : lines(shape), phase_rad(phase) {
        for (auto n : lines) {
            if (n < 2 || count > std::numeric_limits<std::size_t>::max()/n)
                throw std::invalid_argument("invalid or overflowing grid shape");
            count *= n;
        }
        for (std::size_t a=0; a<2; ++a) {
            if (!std::isfinite(phase[a])) throw std::invalid_argument("phase must be finite");
            cosine[a] = std::cos(phase[a]);
            sine[a] = std::sin(phase[a]);
        }
    }
    std::size_t index(std::size_t c, const std::array<std::size_t, 3>& p) const {
        if (c >= 3 || p[0] >= lines[0] || p[1] >= lines[1] || p[2] >= lines[2])
            throw std::out_of_range("field index");
        return ((c*lines[0]+p[0])*lines[1]+p[1])*lines[2]+p[2];
    }
};

using Field = std::vector<Pair>;
using Coefficients = std::vector<double>;

inline void require_size(const Grid& g, std::size_t size) {
    if (size != g.count) throw std::invalid_argument("array does not match grid");
}

// Positive seam multiplier exp(+i phase) belongs to the exp(-i omega t)
// foundation convention. Corner endpoints acquire both x and y multipliers.
inline void sync_positive_planes(const Grid& g, Field& f) {
    require_size(g, f.size());
    for (std::size_t a=0; a<2; ++a) {
        const auto b=(a+1)%3, c=(a+2)%3;
        std::array<std::size_t, 3> p{};
        for (p[b]=0; p[b]<g.lines[b]; ++p[b])
        for (p[c]=0; p[c]<g.lines[c]; ++p[c])
        for (std::size_t component=0; component<3; ++component) {
            auto q=p;
            q[a]=g.lines[a]-1;
            f[g.index(component,q)] = rotate(f[g.index(component,p)], g.cosine[a], g.sine[a]);
        }
    }
}

inline Pair backward_operand(const Grid& g, const Field& f, std::size_t c,
                             std::array<std::size_t, 3> p, std::size_t a) {
    if (p[a] != 0) {
        --p[a];
        return f[g.index(c,p)];
    }
    if (a == 2) return f[g.index(c,p)]; // Native low-z clamped difference.
    p[a] = g.lines[a]-2;
    return rotate(f[g.index(c,p)], g.cosine[a], -g.sine[a]);
}

// Coefficients are real circuit-update coefficients, including metric/material
// factors supplied by the caller. This kernel does not construct physical coefficients.
inline void update_voltage(const Grid& g, Field& v, const Field& h,
                           const Coefficients& vv, const Coefficients& vi) {
    require_size(g,v.size()); require_size(g,h.size());
    require_size(g,vv.size()); require_size(g,vi.size());
    if (&v == &h) throw std::invalid_argument("electric and magnetic storage must differ");
    std::array<std::size_t, 3> p{};
    for (p[0]=0; p[0]<g.lines[0]-1; ++p[0])
    for (p[1]=0; p[1]<g.lines[1]-1; ++p[1])
    for (p[2]=0; p[2]<g.lines[2]; ++p[2])
    for (std::size_t c=0; c<3; ++c) {
        const auto a=(c+1)%3, b=(c+2)%3, i=g.index(c,p);
        const Pair curl = h[g.index(b,p)]-backward_operand(g,h,b,p,a)
                         -h[g.index(a,p)]+backward_operand(g,h,a,p,b);
        v[i] = vv[i]*v[i]+vi[i]*curl;
    }
}

// E's high duplicate planes must be synchronized before this call, as in
// openEMS Engine::IterateTS. The last z plane of H is not advanced.
inline void update_current(const Grid& g, Field& h, const Field& v,
                           const Coefficients& ii, const Coefficients& iv) {
    require_size(g,v.size()); require_size(g,h.size());
    require_size(g,ii.size()); require_size(g,iv.size());
    if (&v == &h) throw std::invalid_argument("electric and magnetic storage must differ");
    std::array<std::size_t, 3> p{};
    for (p[0]=0; p[0]<g.lines[0]-1; ++p[0])
    for (p[1]=0; p[1]<g.lines[1]-1; ++p[1])
    for (p[2]=0; p[2]<g.lines[2]-1; ++p[2])
    for (std::size_t c=0; c<3; ++c) {
        const auto a=(c+1)%3, b=(c+2)%3, i=g.index(c,p);
        auto pa=p, pb=p;
        ++pa[a]; ++pb[b];
        const Pair negative_curl = v[g.index(b,p)]-v[g.index(b,pa)]
                                  -v[g.index(a,p)]+v[g.index(a,pb)];
        h[i] = ii[i]*h[i]+iv[i]*negative_curl;
    }
}

// Paired version of the scalar UPML pre/post recurrence. These arbitrary
// coefficients permit algebra tests; they do not specify a qualified absorber.
struct FluxState {
    Field flux;
    Field pending;
    Coefficients a, old_flux, new_flux;
    std::vector<bool> active;
    bool prepared = false;
    explicit FluxState(const Grid& g)
        : flux(g.count), pending(g.count), a(g.count,1), old_flux(g.count,0),
          new_flux(g.count,1), active(g.count,false) {}
    void validate(const Grid& g) const {
        for (auto size : {flux.size(),pending.size(),a.size(),old_flux.size(),new_flux.size(),active.size()})
            require_size(g,size);
    }
    void pre(const Grid& g, Field& f) {
        validate(g); require_size(g,f.size());
        if (prepared) throw std::logic_error("flux pre called twice");
        for (std::size_t i=0; i<f.size(); ++i) if (active[i]) {
            pending[i] = a[i]*f[i]-old_flux[i]*flux[i];
            f[i] = flux[i];
        }
        prepared = true;
    }
    void post(const Grid& g, Field& f) {
        validate(g); require_size(g,f.size());
        if (!prepared) throw std::logic_error("flux post requires pre");
        for (std::size_t i=0; i<f.size(); ++i) if (active[i]) {
            flux[i] = f[i];
            f[i] = pending[i]+new_flux[i]*flux[i];
        }
        prepared = false;
    }
};

struct Source {
    std::size_t index;
    Pair increment;
};
inline void apply_sources(Field& field, const std::vector<Source>& sources) {
    // Validate before writing, including both quadratures.
    for (const auto& source : sources)
        if (source.index >= field.size() || !std::isfinite(source.increment.real)
            || !std::isfinite(source.increment.imag))
            throw std::invalid_argument("invalid paired source");
    for (const auto& source : sources) field[source.index] = field[source.index]+source.increment;
}

struct Engine {
    Grid grid;
    Field voltage, current;
    Coefficients vv, vi, ii, iv;
    explicit Engine(Grid g) : grid(g), voltage(g.count), current(g.count),
        vv(g.count,1), vi(g.count,0), ii(g.count,1), iv(g.count,0) {}

    // Source increments are already evaluated at their respective E/H times.
    // Only unique x/y cells may be driven; high duplicate endpoints are derived.
    void step(const std::vector<Source>& electric={}, const std::vector<Source>& magnetic={},
              FluxState* electric_flux=nullptr, FluxState* magnetic_flux=nullptr) {
        for (const auto* sources : {&electric,&magnetic}) for (const auto& s : *sources) {
            if (s.index >= grid.count) throw std::invalid_argument("invalid source index");
            const auto x = (s.index/grid.lines[2]/grid.lines[1])%grid.lines[0];
            const auto y = (s.index/grid.lines[2])%grid.lines[1];
            if (x == grid.lines[0]-1 || y == grid.lines[1]-1
                || !std::isfinite(s.increment.real) || !std::isfinite(s.increment.imag))
                throw std::invalid_argument("source requires finite increment on a unique cell");
        }
        if (electric_flux == magnetic_flux && electric_flux != nullptr)
            throw std::invalid_argument("E and H require independent flux states");
        // Initial data must satisfy the same seam relation as subsequent steps.
        sync_positive_planes(grid,current);
        if (electric_flux) electric_flux->pre(grid,voltage);
        update_voltage(grid,voltage,current,vv,vi);
        if (electric_flux) electric_flux->post(grid,voltage);
        apply_sources(voltage,electric);
        sync_positive_planes(grid,voltage);
        if (electric_flux) sync_positive_planes(grid,electric_flux->flux);
        if (magnetic_flux) magnetic_flux->pre(grid,current);
        update_current(grid,current,voltage,ii,iv);
        if (magnetic_flux) magnetic_flux->post(grid,current);
        apply_sources(current,magnetic);
        sync_positive_planes(grid,current);
        if (magnetic_flux) sync_positive_planes(grid,magnetic_flux->flux);
    }
};
} // namespace fairbeam_bloch
#endif
