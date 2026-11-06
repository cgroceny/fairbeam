#!/usr/bin/env node
// Display units (src/lib/displayUnits.ts): designs store mm and GHz; the chosen units only change
// what fields show and how typed numbers are read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromTyped, kindOf, shownUnit, toShown } from "../src/lib/displayUnits.ts";

const mmGHz = { length: "mm", frequency: "GHz" };
const cmMHz = { length: "cm", frequency: "MHz" };
assert.equal(kindOf("mm"), "length");
assert.equal(kindOf("GHz"), "frequency");
assert.equal(kindOf("Ω"), null);
assert.equal(shownUnit("mm", cmMHz), "cm");
assert.equal(shownUnit("GHz", cmMHz), "MHz");
assert.equal(shownUnit("deg", cmMHz), "deg", "other units are left alone");
assert.equal(toShown(10, "mm", cmMHz), 1, "10 mm reads 1 in cm");
assert.equal(toShown(0.0071, "GHz", cmMHz), 7.1, "0.0071 GHz reads 7.1 in MHz");
assert.equal(toShown(5, "deg", cmMHz), 5);
assert.equal(fromTyped("1", "mm", cmMHz), 10, "a plain number is read in the chosen unit");
assert.equal(fromTyped("7.1", "GHz", cmMHz), 0.0071);
assert.equal(fromTyped("1 cm", "mm", mmGHz), 10, "a number with a unit is read in that unit");
assert.equal(fromTyped("2m", "mm", mmGHz), 2000);
assert.equal(fromTyped("1 in", "mm", mmGHz), 25.4);
assert.equal(fromTyped("7.1 MHz", "GHz", mmGHz), 0.0071);
assert.equal(fromTyped("2,5 cm", "mm", mmGHz), 25, "a decimal comma reads as a point");
assert.equal(fromTyped("3", "mm", mmGHz), 3, "mm stays mm");
assert.equal(fromTyped("w/2", "mm", cmMHz), null, "expressions are not converted");
assert.equal(fromTyped("1 MHz", "mm", mmGHz), null, "a unit of the other kind is not a length");
assert.equal(fromTyped("1", "deg", cmMHz), null, "fields without a length or frequency unit are left alone");
for (const x of [0.3, 17.5, 19605.633802816905]) assert.ok(Math.abs(fromTyped(String(toShown(x, "mm", cmMHz)), "mm", cmMHz) - x) <= 1e-12 * x, `round trip ${x}`);

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
assert.match(read("src/designer/StatusBar.tsx"), /<UnitsMenu \/>/, "the status bar's units open a menu");
assert.match(read("src/designer/DesignPane.tsx"), /fromTyped\(e\.currentTarget\.value, canonical\(\)\) \?\? toExpr/, "value fields convert typed numbers");
assert.match(read("src/designer/RibbonField.tsx"), /fromTyped\(value, props\.unit\)/);
assert.match(read("src/components/GeneralSettings.tsx"), /setDisplayUnits\(\{ length:/, "Settings picks the units too");
console.log("display units: conversion, parsing and entry points ok");
