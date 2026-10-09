// SPDX-License-Identifier: GPL-3.0-or-later
#include "bloch_kernel.h"
#include <algorithm>
#include <complex>
#include <iomanip>
#include <iostream>
#include <string>

using Complex = std::complex<double>;
using ComplexField = std::vector<Complex>;
using namespace fairbeam_bloch;
static constexpr double pi = 3.14159265358979323846;
static double worst_error = 0;
static int checks = 0;

static Complex as_complex(Pair p) { return {p.real,p.imag}; }
static Pair as_pair(Complex p) { return {p.real(),p.imag()}; }
static void check(bool condition, const std::string& message) {
    ++checks;
    if (!condition) throw std::runtime_error(message);
}
static void near(Complex actual, Complex expected, const std::string& name) {
    const double error = std::abs(actual-expected)/std::max(1.0,std::abs(expected));
    worst_error = std::max(worst_error,error);
    check(error < 2e-12,name+" differs from independent reference");
}

// Independent reference stores std::complex values and wraps logical neighbor
// coordinates directly. It never calls the paired stencil or reads its ghosts.
struct Reference {
    Grid grid;
    ComplexField e, h, ef, hf;
    explicit Reference(const Engine& native) : grid(native.grid),
        e(grid.count),h(grid.count),ef(grid.count),hf(grid.count) {
        for (std::size_t i=0; i<grid.count; ++i) {
            e[i]=as_complex(native.voltage[i]); h[i]=as_complex(native.current[i]);
        }
    }
    Complex sample(const ComplexField& f, std::size_t c,
                   std::array<std::size_t,3> p, std::size_t a, int direction) const {
        if (a==2) {
            if (direction<0 && p[a]==0) return f[grid.index(c,p)];
            if (direction<0) --p[a]; else ++p[a];
            return f[grid.index(c,p)];
        }
        const auto unique=grid.lines[a]-1;
        double phase=0;
        if (direction>0 && p[a]==unique-1) { p[a]=0; phase=grid.phase_rad[a]; }
        else if (direction<0 && p[a]==0) { p[a]=unique-1; phase=-grid.phase_rad[a]; }
        else if (direction>0) ++p[a]; else --p[a];
        return std::exp(Complex(0,phase))*f[grid.index(c,p)];
    }
    Complex derivative(const ComplexField& f, std::size_t c,
                       std::array<std::size_t,3> p, std::size_t a, bool forward) const {
        const Complex at=f[grid.index(c,p)];
        return forward ? sample(f,c,p,a,1)-at : at-sample(f,c,p,a,-1);
    }
    std::array<Complex,3> curl(const ComplexField& f,
                              std::array<std::size_t,3> p, bool forward) const {
        return {derivative(f,2,p,1,forward)-derivative(f,1,p,2,forward),
                derivative(f,0,p,2,forward)-derivative(f,2,p,0,forward),
                derivative(f,1,p,0,forward)-derivative(f,0,p,1,forward)};
    }
    void sync(ComplexField& f) const {
        for (std::size_t c=0; c<3; ++c)
        for (std::size_t x=0; x<grid.lines[0]; ++x)
        for (std::size_t y=0; y<grid.lines[1]; ++y)
        for (std::size_t z=0; z<grid.lines[2]; ++z) {
            if (x<grid.lines[0]-1 && y<grid.lines[1]-1) continue;
            const std::array<std::size_t,3> p{x,y,z};
            const std::array<std::size_t,3> q{x%(grid.lines[0]-1),y%(grid.lines[1]-1),z};
            const double phase=(x==grid.lines[0]-1 ? grid.phase_rad[0] : 0)
                              +(y==grid.lines[1]-1 ? grid.phase_rad[1] : 0);
            f[grid.index(c,p)]=std::exp(Complex(0,phase))*f[grid.index(c,q)];
        }
    }
    void half_step(ComplexField& target, const ComplexField& operand,
                   const Coefficients& keep, const Coefficients& scale,
                   bool magnetic, ComplexField& flux, const FluxState* state) {
        ComplexField pending(grid.count);
        if (state) for (std::size_t i=0; i<grid.count; ++i) if (state->active[i]) {
            pending[i]=state->a[i]*target[i]-state->old_flux[i]*flux[i];
            target[i]=flux[i];
        }
        for (std::size_t x=0; x<grid.lines[0]-1; ++x)
        for (std::size_t y=0; y<grid.lines[1]-1; ++y)
        for (std::size_t z=0; z<grid.lines[2]-(magnetic ? 1 : 0); ++z) {
            const std::array<std::size_t,3> p{x,y,z};
            const auto result=curl(operand,p,magnetic);
            for (std::size_t c=0; c<3; ++c) {
                const auto i=grid.index(c,p);
                target[i]=keep[i]*target[i]+(magnetic ? -1.0 : 1.0)*scale[i]*result[c];
            }
        }
        if (state) for (std::size_t i=0; i<grid.count; ++i) if (state->active[i]) {
            flux[i]=target[i];
            target[i]=pending[i]+state->new_flux[i]*flux[i];
        }
    }
    void step(const Engine& coefficients, const std::vector<Source>& electric,
              const std::vector<Source>& magnetic, const FluxState* ev=nullptr,
              const FluxState* hv=nullptr) {
        sync(h);
        half_step(e,h,coefficients.vv,coefficients.vi,false,ef,ev);
        for (const auto& source : electric) e[source.index]+=as_complex(source.increment);
        sync(e); if (ev) sync(ef);
        half_step(h,e,coefficients.ii,coefficients.iv,true,hf,hv);
        for (const auto& source : magnetic) h[source.index]+=as_complex(source.increment);
        sync(h); if (hv) sync(hf);
    }
};

static void compare(const Field& a, const ComplexField& b, const std::string& name) {
    check(a.size()==b.size(),"reference size");
    for (std::size_t i=0; i<a.size(); ++i) near(as_complex(a[i]),b[i],name);
}
static void populate(Engine& engine, bool real_only=false) {
    for (std::size_t i=0; i<engine.grid.count; ++i) {
        const auto j=static_cast<double>(i+1);
        engine.voltage[i]={std::sin(j*0.31),real_only ? 0 : std::cos(j*0.73)};
        engine.current[i]={std::cos(j*0.17),real_only ? 0 : std::sin(j*0.43)};
        engine.vv[i]=0.97+0.01*std::sin(j); engine.vi[i]=0.03+0.005*std::cos(j);
        engine.ii[i]=0.96+0.01*std::cos(j); engine.iv[i]=0.04+0.005*std::sin(j);
    }
    sync_positive_planes(engine.grid,engine.voltage);
    sync_positive_planes(engine.grid,engine.current);
}

static void seam_and_corner() {
    for (const auto shape : {std::array<std::size_t,3>{2,2,2}, {6,5,4}})
    for (double phase : {0.0,0.79,-1.43,11*pi+0.13}) {
        Engine engine(Grid(shape,{phase,-0.37})); populate(engine);
        Reference reference(engine); reference.sync(reference.e); reference.sync(reference.h);
        compare(engine.voltage,reference.e,"electric planes/corner");
        compare(engine.current,reference.h,"magnetic planes/corner");
    }
}

static void eigenmode_curls() {
    const Grid g({8,7,4},{1.17,-0.73});
    Engine engine(g);
    const double kx=(g.phase_rad[0]+2*pi)/static_cast<double>(g.lines[0]-1);
    const double ky=(g.phase_rad[1]-4*pi)/static_cast<double>(g.lines[1]-1);
    const std::array<Complex,3> amplitude{Complex(0.4,-0.2),Complex(-0.7,0.8),Complex(1.2,0.3)};
    for (std::size_t x=0; x<g.lines[0]-1; ++x)
    for (std::size_t y=0; y<g.lines[1]-1; ++y)
    for (std::size_t z=0; z<g.lines[2]; ++z)
    for (std::size_t c=0; c<3; ++c) {
        const auto carrier=std::exp(Complex(0,kx*static_cast<double>(x)+ky*static_cast<double>(y)));
        engine.voltage[g.index(c,{x,y,z})]=as_pair(amplitude[c]*carrier);
        engine.current[g.index(c,{x,y,z})]=as_pair(amplitude[c]*carrier);
    }
    sync_positive_planes(g,engine.voltage); sync_positive_planes(g,engine.current);
    Field backward(g.count),forward(g.count);
    const Coefficients zero(g.count,0),one(g.count,1);
    update_voltage(g,backward,engine.current,zero,one);
    update_current(g,forward,engine.voltage,zero,one);
    const auto bx=1.0-std::exp(Complex(0,-kx)),by=1.0-std::exp(Complex(0,-ky));
    const auto fx=std::exp(Complex(0,kx))-1.0,fy=std::exp(Complex(0,ky))-1.0;
    const std::array<Complex,3> b{by*amplitude[2],-bx*amplitude[2],bx*amplitude[1]-by*amplitude[0]};
    const std::array<Complex,3> f{-fy*amplitude[2],fx*amplitude[2],-fx*amplitude[1]+fy*amplitude[0]};
    for (std::size_t x=0; x<g.lines[0]-1; ++x)
    for (std::size_t y=0; y<g.lines[1]-1; ++y)
    for (std::size_t z=0; z<g.lines[2]-1; ++z)
    for (std::size_t c=0; c<3; ++c) {
        const auto carrier=std::exp(Complex(0,kx*static_cast<double>(x)+ky*static_cast<double>(y)));
        near(as_complex(backward[g.index(c,{x,y,z})]),b[c]*carrier,"analytical backward curl");
        near(as_complex(forward[g.index(c,{x,y,z})]),f[c]*carrier,"analytical negative forward curl");
    }
}

static void adjoint_seams() {
    // D_minus = -D_plus^* for each transverse axis, independently of z boundaries.
    Engine engine(Grid({7,6,3},{1.23,-0.94})); populate(engine);
    Reference ref(engine);
    for (std::size_t axis=0; axis<2; ++axis) {
        Complex sum=0;
        for (std::size_t x=0; x<engine.grid.lines[0]-1; ++x)
        for (std::size_t y=0; y<engine.grid.lines[1]-1; ++y) {
            const std::array<std::size_t,3> p{x,y,1};
            const auto i=engine.grid.index(2,p);
            // Backward derivative uses the native paired operand; forward
            // derivative reads the synchronized positive duplicate planes.
            const auto backward=as_complex(engine.current[i]-backward_operand(engine.grid,engine.current,2,p,axis));
            auto q=p; ++q[axis];
            const auto forward=as_complex(engine.voltage[engine.grid.index(2,q)]-engine.voltage[i]);
            sum+=std::conj(as_complex(engine.voltage[i]))*backward
                 +std::conj(forward)*as_complex(engine.current[i]);
        }
        near(sum,0,"transverse derivative adjoint");
    }
}

static void repeated_steps(bool flux_enabled, bool zero_phase) {
    Engine engine(Grid({6,5,4},zero_phase ? std::array<double,2>{0,0} : std::array<double,2>{0.87,-1.19}));
    populate(engine,zero_phase);
    Reference ref(engine);
    FluxState eflux(engine.grid),hflux(engine.grid);
    for (std::size_t i=0; i<engine.grid.count; ++i) {
        const auto z=i%engine.grid.lines[2];
        eflux.active[i]=(z==0 || z==engine.grid.lines[2]-1);
        hflux.active[i]=(z==0);
        eflux.a[i]=0.81; eflux.old_flux[i]=0.32; eflux.new_flux[i]=0.21;
        hflux.a[i]=0.76; hflux.old_flux[i]=0.27; hflux.new_flux[i]=0.18;
    }
    for (int step=0; step<31; ++step) {
        const double t=static_cast<double>(step);
        const std::vector<Source> es{{engine.grid.index(2,{0,0,1}),{0.01*std::cos(t),zero_phase ? 0 : -0.02*std::sin(t)}}};
        const std::vector<Source> hs{{engine.grid.index(0,{4,3,2}),{-0.015*std::sin(t),zero_phase ? 0 : 0.009*std::cos(t)}}};
        ref.step(engine,es,hs,flux_enabled ? &eflux : nullptr,flux_enabled ? &hflux : nullptr);
        engine.step(es,hs,flux_enabled ? &eflux : nullptr,flux_enabled ? &hflux : nullptr);
        compare(engine.voltage,ref.e,"31-step electric reference");
        compare(engine.current,ref.h,"31-step magnetic reference");
        if (flux_enabled) {
            compare(eflux.flux,ref.ef,"electric paired auxiliary reference");
            compare(hflux.flux,ref.hf,"magnetic paired auxiliary reference");
        }
        if (zero_phase) for (std::size_t i=0; i<engine.grid.count; ++i) {
            check(engine.voltage[i].imag==0,"zero-phase imaginary electric drift");
            check(engine.current[i].imag==0,"zero-phase imaginary magnetic drift");
        }
    }
}

static void conjugation_bridge() {
    // For foundation F(t)=F0 exp(-i wt), quadrature traces are Re F and Im F.
    // The negative-kernel transforms R/I combine as DFT(R)-i DFT(I)=conj(F0).
    // DFT(R) alone is sufficient only for the ordinary real zero-phase trace.
    const Complex e(0.7,-0.4),h(-0.2,0.9);
    for (Complex amplitude : {e,h}) {
        Complex real_dft=0,imag_dft=0;
        constexpr int n=64, bin=5;
        for (int j=0; j<n; ++j) {
            const double angle=2*pi*bin*j/n;
            const Complex temporal=amplitude*std::exp(Complex(0,-angle));
            const Complex kernel=std::exp(Complex(0,-angle));
            real_dft+=(2.0/n)*temporal.real()*kernel;
            imag_dft+=(2.0/n)*temporal.imag()*kernel;
        }
        near(real_dft,std::conj(amplitude),"real trace negative DFT");
        // Each single-sided transform includes factor two: combine and halve.
        near((real_dft-Complex(0,1)*imag_dft)/2.0,std::conj(amplitude),"paired native spectrum bridge");
        near((std::conj(real_dft)+Complex(0,1)*std::conj(imag_dft))/2.0,amplitude,"paired foundation spectrum bridge");
    }
    Engine positive(Grid({5,4,3},{0.71,-0.83})); populate(positive);
    Engine conjugate(Grid({5,4,3},{-0.71,0.83}));
    conjugate.vv=positive.vv; conjugate.vi=positive.vi;
    conjugate.ii=positive.ii; conjugate.iv=positive.iv;
    for (std::size_t i=0; i<positive.grid.count; ++i) {
        conjugate.voltage[i]=as_pair(std::conj(as_complex(positive.voltage[i])));
        conjugate.current[i]=as_pair(std::conj(as_complex(positive.current[i])));
    }
    for (int i=0; i<9; ++i) {
        positive.step(); conjugate.step();
        for (std::size_t j=0; j<positive.grid.count; ++j) {
            near(as_complex(conjugate.voltage[j]),std::conj(as_complex(positive.voltage[j])),"conjugated E phase sign");
            near(as_complex(conjugate.current[j]),std::conj(as_complex(positive.current[j])),"conjugated H phase sign");
        }
    }
}

template <typename Exception, typename Function> static void rejects(Function function) {
    bool threw=false;
    try { function(); } catch (const Exception&) { threw=true; }
    check(threw,"invalid input was accepted");
}
static void guards() {
    rejects<std::invalid_argument>([]{ Grid g({1,4,4},{0,0}); });
    rejects<std::invalid_argument>([]{ Grid g({4,4,4},{std::numeric_limits<double>::infinity(),0}); });
    rejects<std::invalid_argument>([]{ Grid g({std::numeric_limits<std::size_t>::max(),4,4},{0,0}); });
    Engine e(Grid({4,4,3},{0.2,-0.3}));
    Field small(2);
    rejects<std::invalid_argument>([&]{ sync_positive_planes(e.grid,small); });
    rejects<std::invalid_argument>([&]{ update_voltage(e.grid,e.voltage,e.voltage,e.vv,e.vi); });
    rejects<std::invalid_argument>([&]{ e.step({{e.grid.index(0,{3,0,1}),{1,2}}}); });
    rejects<std::invalid_argument>([&]{ e.step({{0,{std::numeric_limits<double>::quiet_NaN(),0}}}); });
    FluxState flux(e.grid);
    rejects<std::invalid_argument>([&]{ e.step({}, {}, &flux,&flux); });
    rejects<std::logic_error>([&]{ flux.post(e.grid,e.voltage); });
    flux.pre(e.grid,e.voltage);
    rejects<std::logic_error>([&]{ flux.pre(e.grid,e.voltage); });
    flux.post(e.grid,e.voltage);
}

int main() {
    try {
        seam_and_corner(); eigenmode_curls(); adjoint_seams();
        repeated_steps(false,false); repeated_steps(true,false);
        repeated_steps(false,true); repeated_steps(true,true);
        conjugation_bridge(); guards();
        std::cout << std::setprecision(17)
                  << "{\"schema\":1,\"status\":\"passed\",\"groups\":9,\"checks\":" << checks
                  << ",\"max_scaled_error\":" << worst_error
                  << ",\"native_openems_support\":false,\"physical_validation\":false}\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "native Bloch kernel test failed: " << error.what() << '\n';
        return 1;
    }
}
