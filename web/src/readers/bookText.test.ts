import { describe, expect, it } from "vitest";
import { findInSections } from "./bookText";
describe("whole book search",()=>{
 it("finds repeated hits across all pages and retains their destinations",()=>{
  const hits=findInSections([{position:0,label:"1",locator:{pageIndex:0},text:"幂等接口必须幂等"},{position:1,label:"2",locator:{pageIndex:1},text:"下一页也有幂等"}],"幂等");
  expect(hits).toHaveLength(3);expect(hits[2].locator).toEqual({pageIndex:1,search:"幂等",occurrence:0});expect(hits[1].offset).toBe(6);
 });
 it("uses literal matching, handles Unicode, and bounds result size",()=>{
  const sections=[{position:0,label:"body",locator:{href:"chapter.xhtml"},text:"😀 A.B a.b "+"x".repeat(1200)}];
  expect(findInSections(sections,"A.B")).toHaveLength(2);expect(findInSections(sections,"😀")[0].offset).toBe(0);expect(findInSections(sections,"x")).toHaveLength(1000);expect(findInSections(sections,"   ")).toEqual([]);
 });
});
