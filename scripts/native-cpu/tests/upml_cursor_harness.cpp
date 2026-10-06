#include "tools/arraylib/array_e.h"
#include "FDTD/extensions/engine_ext_upml_sse_cursor.h"

#include <cstdint>
#include <iostream>
#include <typeinfo>

struct ExactSSEFixture
{
	virtual ~ExactSSEFixture() {}
};
struct ExactCompressedFixture : ExactSSEFixture {};
struct ExactMultithreadFixture : ExactCompressedFixture {};
struct UnknownDerivedFixture : ExactMultithreadFixture {};

static bool CheckExactEngineTypeAllowlist()
{
	typedef ExactSSEFixture SSE;
	typedef ExactCompressedFixture Compressed;
	typedef ExactMultithreadFixture MultiThread;
	if (!IsExactUpmlSSECursorEngineType<SSE, Compressed, MultiThread>(typeid(SSE)) ||
		!IsExactUpmlSSECursorEngineType<SSE, Compressed, MultiThread>(typeid(Compressed)) ||
		!IsExactUpmlSSECursorEngineType<SSE, Compressed, MultiThread>(typeid(MultiThread)) ||
		IsExactUpmlSSECursorEngineType<SSE, Compressed, MultiThread>(typeid(UnknownDerivedFixture)))
	{
		std::cerr << "exact UPML engine type allowlist accepted/rejected the wrong dynamic type\\n";
		return false;
	}
	return true;
}
struct TestVector4
{
	float f[4];
};

static float PhysicalValue(unsigned int component, unsigned int x, unsigned int y, unsigned int z)
{
	return static_cast<float>(component * 100000 + x * 10000 + y * 1000 + z);
}

static float PaddingValue(unsigned int component, unsigned int r, unsigned int lane)
{
	return static_cast<float>(-1000 - component * 100 - r * 10 - lane);
}

static bool CheckRange(
	ArrayLib::ArrayENG<TestVector4>& field,
	unsigned int physicalNz,
	unsigned int x,
	unsigned int y,
	unsigned int startZ
)
{
	const unsigned int vectorCount = field.extent(3);
	const unsigned int startVector = startZ % vectorCount;
	const unsigned int startLane = startZ / vectorCount;
	const unsigned int vectorOffset = field.linearIndex({0, x, y, startVector});
	Engine_Ext_UPML_SSE_Cursor<TestVector4> cursor;
	cursor.BeginRow(
		field.data(), vectorOffset, vectorCount, field.stride(0), field.stride(3), startVector, startLane
	);

	for (unsigned int z=startZ; z<physicalNz; ++z)
	{
		const unsigned int expectedVector = z % vectorCount;
		const unsigned int expectedLane = z / vectorCount;
		if (expectedLane >= 4)
		{
			std::cerr << "physical z mapped beyond the four SIMD lanes\n";
			return false;
		}
		for (unsigned int component=0; component<3; ++component)
		{
			const float expected = field(component, x, y, expectedVector).f[expectedLane];
			const float actual = cursor.Component(component);
			if (actual != expected || expected != PhysicalValue(component, x, y, z))
			{
				std::cerr << "cursor mismatch at component=" << component
					<< " x=" << x << " y=" << y << " z=" << z
					<< " vector=" << expectedVector << " lane=" << expectedLane
					<< " actual=" << actual << " expected=" << expected << '\n';
				return false;
			}
			const float replacement = expected + 0.5f;
			cursor.Component(component) = replacement;
			if (field(component, x, y, expectedVector).f[expectedLane] != replacement)
			{
				std::cerr << "cursor write reached the wrong physical lane\n";
				return false;
			}
			cursor.Component(component) = expected;
		}
		cursor.Advance();
	}
	return true;
}

int main()
{
	if (!CheckExactEngineTypeAllowlist())
		return 1;

	const unsigned int xExtent = 4;
	const unsigned int yExtent = 5;
	for (unsigned int remainder=0; remainder<4; ++remainder)
	{
		const unsigned int physicalNz = 8 + remainder;
		const unsigned int vectorCount = (physicalNz + 3) / 4;
		ArrayLib::ArrayENG<TestVector4> field("cursor-harness", {xExtent, yExtent, vectorCount});
		for (unsigned int component=0; component<3; ++component)
			for (unsigned int x=0; x<xExtent; ++x)
				for (unsigned int y=0; y<yExtent; ++y)
					for (unsigned int r=0; r<vectorCount; ++r)
						for (unsigned int lane=0; lane<4; ++lane)
						{
							const unsigned int z = lane * vectorCount + r;
							field(component, x, y, r).f[lane] =
								z < physicalNz ? PhysicalValue(component, x, y, z) : PaddingValue(component, r, lane);
						}

		// Check full physical rows and a nonzero UPML range that crosses vector-index wraps.
		for (unsigned int x=1; x<3; ++x)
			for (unsigned int y=1; y<4; ++y)
			{
				if (!CheckRange(field, physicalNz, x, y, 0))
					return 1;
				const unsigned int pmlStartZ = vectorCount + 1;
				if (!CheckRange(field, physicalNz, x, y, pmlStartZ))
					return 1;
			}
	}

	std::cout << "UPML SSE cursor mapping and exact-type allowlist passed for Nz mod 4 = 0,1,2,3, nonzero starts, row resets, and padded lanes.\n";
	return 0;
}
