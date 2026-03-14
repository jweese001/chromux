import XCTest

#if canImport(cmux_DEV)
@testable import cmux_DEV
#elseif canImport(cmux)
@testable import cmux
#endif

final class GhosttyScrollbarSyncPlanTests: XCTestCase {
    func testPreservesStoredTopVisibleRowWhenNewOutputArrives() {
        let plan = ghosttyScrollViewportSyncPlan(
            scrollbar: GhosttyScrollbar(total: 105, offset: 10, len: 20),
            storedTopVisibleRow: 70,
            isExplicitViewportChange: false
        )

        XCTAssertEqual(plan.targetTopVisibleRow, 70)
        XCTAssertEqual(plan.targetRowFromBottom, 15)
        XCTAssertEqual(plan.storedTopVisibleRow, 70)
    }

    func testExplicitViewportChangeUsesIncomingScrollbarPosition() {
        let plan = ghosttyScrollViewportSyncPlan(
            scrollbar: GhosttyScrollbar(total: 100, offset: 15, len: 20),
            storedTopVisibleRow: 70,
            isExplicitViewportChange: true
        )

        XCTAssertEqual(plan.targetTopVisibleRow, 65)
        XCTAssertEqual(plan.targetRowFromBottom, 15)
        XCTAssertEqual(plan.storedTopVisibleRow, 65)
    }

    func testBottomPositionClearsStoredAnchor() {
        let plan = ghosttyScrollViewportSyncPlan(
            scrollbar: GhosttyScrollbar(total: 100, offset: 0, len: 20),
            storedTopVisibleRow: 70,
            isExplicitViewportChange: true
        )

        XCTAssertEqual(plan.targetTopVisibleRow, 80)
        XCTAssertEqual(plan.targetRowFromBottom, 0)
        XCTAssertNil(plan.storedTopVisibleRow)
    }
}
