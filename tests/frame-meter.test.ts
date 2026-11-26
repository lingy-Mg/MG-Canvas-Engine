import {test} from "node:test";
import assert from "node:assert/strict";
import {frameColumns} from "../app/frame-meter.ts";

test("one slow frame stays at the bottom of its column and the chart",()=>{
  const samples=[
    {at:4110,interval:16},{at:4126,interval:16},
    {at:4950,interval:824},{at:4966,interval:16},{at:4982,interval:16},
    {at:4998,interval:16}
  ];
  const plot=frameColumns(samples,5000,20);
  assert.deepEqual(plot.columns,[{x:17,interval:16},{x:19,interval:824}]);
  assert.deepEqual(plot.lowest,{x:19,interval:824});
});

test("the minimum scrolls left and expires by timestamp",()=>{
  const samples=[{at:6000,interval:270},{at:6800,interval:16},{at:12001,interval:14}];
  assert.deepEqual(frameColumns(samples,6000,148).lowest,{x:147,interval:270});
  assert.deepEqual(frameColumns(samples,7000,148).lowest,{x:123,interval:270});
  assert.deepEqual(frameColumns(samples,12001,148).lowest,{x:19,interval:16});
  assert.equal(frameColumns(samples,20000,148).lowest,undefined);
});
