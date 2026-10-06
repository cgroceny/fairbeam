#include "tools/arraylib/array_nijk.h"
#include "FDTD/extensions/engine_ext_upml_sse_rows.h"

#include <cstddef>
#include <cstdint>
#include <iostream>

static float TestValue(std::size_t component, std::size_t x, std::size_t y, std::size_t z)
{
	return static_cast<float>(component * 10000 + x * 1000 + y * 100 + z * 10);
}

template <typename IndexType, std::size_t ExtentN>
static bool CheckRows(
	ArrayLib::ArrayNIJK<float, IndexType, ExtentN>& array,
	std::size_t xStart,
	std::size_t xCount,
	std::size_t yCount,
	std::size_t zCount,
	std::size_t yStart = 0
)
{
	if (!UpmlSSERowsHaveBounds(array, xStart, xCount, yCount, zCount))
	{
		std::cerr << "valid ArrayNIJK row range was rejected\n";
		return false;
	}
	if (yStart > static_cast<std::size_t>(array.extent(2)) ||
		yCount > static_cast<std::size_t>(array.extent(2)) - yStart)
	{
		std::cerr << "harness y range is outside the ArrayNIJK extent\n";
		return false;
	}
	if (xCount == 0 || yCount == 0 || zCount == 0)
		return true;

	for (std::size_t x=xStart; x<xStart+xCount; ++x)
		for (std::size_t y=yStart; y<yStart+yCount; ++y)
		{
			UpmlSSENIJKRow3<float, IndexType, ExtentN> row;
			row.BeginRow(array, static_cast<IndexType>(x), static_cast<IndexType>(y));
			for (std::size_t z=0; z<zCount; ++z)
			{
				for (std::size_t component=0; component<3; ++component)
				{
					const float expected = TestValue(component, x, y, z);
					if (row.Component(component) != expected || array(
						static_cast<IndexType>(component), static_cast<IndexType>(x),
						static_cast<IndexType>(y), static_cast<IndexType>(z)) != expected)
					{
						std::cerr << "row pointer disagrees with ArrayNIJK at component=" << component
							<< " x=" << x << " y=" << y << " z=" << z << '\n';
						return false;
					}
				}
				if (z + 1 < zCount)
					row.Advance();
			}
			if (row.Component(0) != TestValue(0, x, y, zCount - 1) ||
				row.Component(2) != TestValue(2, x, y, zCount - 1))
			{
				std::cerr << "row pointer advanced beyond its bounded range\n";
				return false;
			}
		}
	return true;
}

int main()
{
	const std::uint32_t xExtent = 4;
	const std::uint32_t yExtent = 3;
	const std::uint32_t zExtent = 7;
	ArrayLib::ArrayNIJK<float> contiguous("contiguous", {xExtent, yExtent, zExtent});
	for (std::size_t component=0; component<3; ++component)
		for (std::size_t x=0; x<xExtent; ++x)
			for (std::size_t y=0; y<yExtent; ++y)
				for (std::size_t z=0; z<zExtent; ++z)
					contiguous(component, x, y, z) = TestValue(component, x, y, z);

	if (!CheckRows(contiguous, 1, 2, yExtent, zExtent) ||
		!CheckRows(contiguous, 0, 0, yExtent, zExtent) ||
		!CheckRows(contiguous, 0, xExtent, yExtent, 0) ||
		!CheckRows(contiguous, xExtent - 1, 1, 1, 1, yExtent - 1) ||
		!CheckRows(contiguous, xExtent - 1, 1, 1, zExtent, yExtent - 1))
		return 1;
	if (UpmlSSERowsHaveBounds(contiguous, xExtent, 1, yExtent, zExtent) ||
		UpmlSSERowsHaveBounds(contiguous, 0, xExtent, yExtent + 1, zExtent) ||
		UpmlSSERowsHaveBounds(contiguous, 0, xExtent, yExtent, zExtent + 1))
	{
		std::cerr << "out-of-bounds ArrayNIJK row range was accepted\n";
		return 1;
	}

	// Swap the component and z axes to prove the helper follows each array's stride metadata.
	ArrayLib::ArrayNIJK<float> swapped("swapped", {xExtent, yExtent, zExtent});
	swapped.swapAxis(0, 3);
	for (std::size_t component=0; component<swapped.extent(0); ++component)
		for (std::size_t x=0; x<swapped.extent(1); ++x)
			for (std::size_t y=0; y<swapped.extent(2); ++y)
				for (std::size_t z=0; z<swapped.extent(3); ++z)
					swapped(component, x, y, z) = TestValue(component, x, y, z);
	if (!CheckRows(swapped, 1, 2, swapped.extent(2), swapped.extent(3)) ||
		!CheckRows(swapped, swapped.extent(1) - 1, 1, 1, swapped.extent(3), swapped.extent(2) - 1))
		return 1;

	// ArrayNIJK's implementation assumes its default three-component base type;
	// swapping axes safely creates an actual two-component leading extent.
	ArrayLib::ArrayNIJK<float> tooFewComponents("two-components", {2, 2, 2});
	tooFewComponents.swapAxis(0, 1);
	if (UpmlSSERowsHaveBounds(tooFewComponents, 0, 2, 2, 2))
	{
		std::cerr << "row helper accepted fewer than three components\n";
		return 1;
	}

	std::cout << "UPML row-pointer helper passed contiguous, swapped-stride, empty-work, terminal-row, and bounds checks.\n";
	return 0;
}