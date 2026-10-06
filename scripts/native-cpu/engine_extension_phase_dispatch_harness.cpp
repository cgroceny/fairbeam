#include "engine_extension.h"
#include "extensions/engine_extension_phase_dispatch.h"

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace Dispatch = EngineExtensionPhaseDispatch;

class UpmlFixture : public Engine_Extension
{
public:
	UpmlFixture() : Engine_Extension(NULL) {}
};

class ExcitationFixture : public Engine_Extension
{
public:
	ExcitationFixture() : Engine_Extension(NULL) {}
};

class LumpedRLCFixture : public Engine_Extension
{
public:
	LumpedRLCFixture() : Engine_Extension(NULL) {}
};

class MurABCFixture : public Engine_Extension
{
public:
	MurABCFixture() : Engine_Extension(NULL) {}
};

class UnknownFixture : public Engine_Extension
{
public:
	UnknownFixture() : Engine_Extension(NULL), noArgCalls(0), idCalls(0) {}

	void DoPostCurrentUpdates() override { ++noArgCalls; }
	int noArgCalls;
	int idCalls;
};

class DerivedUpmlFixture : public UpmlFixture
{
public:
	DerivedUpmlFixture() : calls(0) {}
	void Apply2Current(int threadID) override
	{
		if (threadID >= 0)
			++calls;
	}
	int calls;
};

template <typename Extension>
Dispatch::PhaseMask classify(const Extension* extension)
{
	return Dispatch::ActivePhases<Engine_Extension, UpmlFixture, ExcitationFixture, LumpedRLCFixture, MurABCFixture>(extension);
}

void require(bool condition, const char* message)
{
	if (!condition)
	{
		std::cerr << "FAIL: " << message << std::endl;
		std::exit(1);
	}
}

bool contains(const std::vector<Engine_Extension*>& list, Engine_Extension* extension)
{
	for (std::size_t n = 0; n < list.size(); ++n)
		if (list[n] == extension)
			return true;
	return false;
}

void checkExactMasks()
{
	UpmlFixture upml;
	ExcitationFixture excitation;
	LumpedRLCFixture lumped;
	MurABCFixture mur;
	UnknownFixture unknown;
	DerivedUpmlFixture derivedUpml;

	require(classify(&upml) == (Dispatch::Bit(Dispatch::PRE_VOLTAGE) |
		Dispatch::Bit(Dispatch::POST_VOLTAGE) | Dispatch::Bit(Dispatch::PRE_CURRENT) |
		Dispatch::Bit(Dispatch::POST_CURRENT)), "exact UPML mask");
	require(classify(&excitation) == (Dispatch::Bit(Dispatch::APPLY_VOLTAGE) |
		Dispatch::Bit(Dispatch::APPLY_CURRENT)), "exact excitation mask");
	require(classify(&lumped) == (Dispatch::Bit(Dispatch::PRE_VOLTAGE) |
		Dispatch::Bit(Dispatch::APPLY_VOLTAGE)), "exact lumped RLC mask");
	require(classify(&mur) == (Dispatch::Bit(Dispatch::PRE_VOLTAGE) |
		Dispatch::Bit(Dispatch::POST_VOLTAGE) | Dispatch::Bit(Dispatch::APPLY_VOLTAGE)), "exact Mur mask");
	require(classify(&unknown) == Dispatch::ALL_PHASES, "unknown extension defaults to all phases");
	require(classify(&derivedUpml) == Dispatch::ALL_PHASES, "derived built-in defaults to all phases");
}

void checkOrderAndBarriers()
{
	UpmlFixture upml;
	ExcitationFixture excitation;
	LumpedRLCFixture lumped;
	MurABCFixture mur;
	UnknownFixture unknown;
	std::vector<Engine_Extension*> sorted;
	sorted.push_back(&upml);
	sorted.push_back(&excitation);
	sorted.push_back(&lumped);
	sorted.push_back(&mur);
	sorted.push_back(&unknown);

	Dispatch::PhaseLists<Engine_Extension> lists;
	Dispatch::Build(sorted, lists, classify<Engine_Extension>);

	const std::vector<Engine_Extension*>& preVoltage = lists.phases[Dispatch::PRE_VOLTAGE];
	require(preVoltage.size() == 5, "pre-voltage schedule keeps one empty-run barrier");
	require(preVoltage[0] == &unknown && preVoltage[1] == &mur && preVoltage[2] == &lumped &&
		preVoltage[3] == NULL && preVoltage[4] == &upml,
		"pre-voltage reverses hook order and retains the empty-run fence");
	const std::vector<Engine_Extension*>& applyVoltage = lists.phases[Dispatch::APPLY_VOLTAGE];
	require(applyVoltage.size() == 5, "apply-voltage schedule keeps one leading empty-run barrier");
	require(applyVoltage[0] == NULL && applyVoltage[1] == &excitation && applyVoltage[2] == &lumped &&
		applyVoltage[3] == &mur && applyVoltage[4] == &unknown,
		"apply-voltage keeps sorted hook order and the leading empty-run fence");

	int waits = 0;
	std::vector<std::string> calls;
	Dispatch::Dispatch(applyVoltage,
		[&calls, &excitation, &lumped, &mur, &unknown](Engine_Extension* extension) {
			if (extension == &excitation) calls.push_back("excitation");
			else if (extension == &lumped) calls.push_back("lumped");
			else if (extension == &mur) calls.push_back("mur");
			else if (extension == &unknown) calls.push_back("unknown");
		},
		[&waits]() { ++waits; });
	require(waits == 5, "empty-run barrier and one barrier after each actual hook");
	require(calls.size() == 4 && calls[0] == "excitation" && calls[1] == "lumped" &&
		calls[2] == "mur" && calls[3] == "unknown", "hook callbacks keep forward extension order");

	waits = 0;
	Dispatch::Dispatch(lists.phases[Dispatch::POST_CURRENT],
		[](Engine_Extension*) {}, [&waits]() { ++waits; });
	require(waits == 3, "active hooks and one intervening empty-run barrier are retained");
	const std::vector<Engine_Extension*>& postCurrent = lists.phases[Dispatch::POST_CURRENT];
	require(postCurrent.size() == 3 && postCurrent[0] == &upml && postCurrent[1] == NULL && postCurrent[2] == &unknown,
		"three consecutive empty hooks collapse to one interior barrier token");

	std::vector<Engine_Extension*> trailingExtensions;
	trailingExtensions.push_back(&unknown);
	trailingExtensions.push_back(&lumped);
	trailingExtensions.push_back(&mur);
	Dispatch::Build(trailingExtensions, lists, classify<Engine_Extension>);
	const std::vector<Engine_Extension*>& trailingEmptyRun = lists.phases[Dispatch::APPLY_CURRENT];
	require(trailingEmptyRun.size() == 2 && trailingEmptyRun[0] == &unknown && trailingEmptyRun[1] == NULL,
		"trailing no-op hooks retain one trailing barrier token");

	std::vector<Engine_Extension*> noHooks;
	noHooks.push_back(&excitation);
	Dispatch::PhaseLists<Engine_Extension> emptyPhase;
	Dispatch::Build(noHooks, emptyPhase, classify<Engine_Extension>);
	waits = 0;
	Dispatch::Dispatch(emptyPhase.phases[Dispatch::PRE_VOLTAGE], [](Engine_Extension*) {}, [&waits]() { ++waits; });
	require(waits == 1, "nonempty extension set retains one barrier in an empty phase");

	noHooks.clear();
	Dispatch::Build(noHooks, emptyPhase, classify<Engine_Extension>);
	waits = 0;
	Dispatch::Dispatch(emptyPhase.phases[Dispatch::PRE_VOLTAGE], [](Engine_Extension*) {}, [&waits]() { ++waits; });
	require(waits == 0, "empty engine has no phase barrier");
}

void checkUnknownHookDelegationAndDerivedOverride()
{
	UnknownFixture unknown;
	DerivedUpmlFixture derivedUpml;
	std::vector<Engine_Extension*> extensions;
	extensions.push_back(&unknown);
	extensions.push_back(&derivedUpml);
	Dispatch::PhaseLists<Engine_Extension> lists;
	Dispatch::Build(extensions, lists, classify<Engine_Extension>);

	// Drive the same production list/dispatch template once per worker. The
	// Engine_Extension::DoPostCurrentUpdates(int) implementation is compiled
	// from the pinned source and delegates its no-argument virtual only at ID 0.
	for (int threadID = 0; threadID < 3; ++threadID)
	{
		int waits = 0;
		Dispatch::Dispatch(lists.phases[Dispatch::POST_CURRENT],
			[threadID](Engine_Extension* extension) { extension->DoPostCurrentUpdates(threadID); },
			[&waits]() { ++waits; });
		require(waits == 2, "both unknown extensions synchronize on every worker");
	}
	require(unknown.noArgCalls == 1, "base thread-ID hook delegates the unknown no-argument hook only on thread zero");

	for (int threadID = 0; threadID < 3; ++threadID)
	{
		int waits = 0;
		Dispatch::Dispatch(lists.phases[Dispatch::APPLY_CURRENT],
			[threadID](Engine_Extension* extension) { extension->Apply2Current(threadID); },
			[&waits]() { ++waits; });
		require(waits == 2, "derived override and unknown hook keep apply-current barriers");
	}
	require(derivedUpml.calls == 3, "derived UPML override remains active in its base-empty phase on all workers");
}

int main()
{
	checkExactMasks();
	checkOrderAndBarriers();
	checkUnknownHookDelegationAndDerivedOverride();
	std::cout << "PASS: pinned-source dispatch lists, phase barriers, exact-type fallback, and thread-zero delegation" << std::endl;
	return 0;
}
