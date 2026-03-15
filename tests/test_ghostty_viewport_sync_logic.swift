import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

func testPreservesStoredTopVisibleRowWhenNewOutputArrives() {
    let plan = ghosttyScrollViewportSyncPlan(
        scrollbar: GhosttyScrollbar(total: 105, offset: 10, len: 20),
        storedTopVisibleRow: 70,
        isExplicitViewportChange: false
    )

    expect(plan.targetTopVisibleRow == 70, "expected stored top row to stay anchored")
    expect(plan.targetRowFromBottom == 15, "expected row-from-bottom to stay aligned with stored top row")
    expect(plan.storedTopVisibleRow == 70, "expected stored top row to persist while off bottom")
}

func testInternalScrollCorrectionDoesNotCountAsExplicitViewportChange() {
    expect(
        ghosttyShouldMarkExplicitViewportChange(
            action: "scroll_to_row:15",
            source: .internalCorrection
        ) == false,
        "internal scroll correction should not mark an explicit viewport change"
    )

    expect(
        ghosttyShouldMarkExplicitViewportChange(
            action: "scroll_to_row:15",
            source: .userInteraction
        ),
        "user scroll_to_row should still count as an explicit viewport change"
    )
}

func testFailedScrollCorrectionDispatchDoesNotBlockRetry() {
    let failed = ghosttyScrollCorrectionDispatchState(
        previousLastSentRow: 4,
        previousPendingAnchorCorrectionRow: nil,
        targetRowFromBottom: 15,
        dispatchSucceeded: false
    )

    expect(failed.lastSentRow == 4, "failed correction should keep the previous last-sent row")
    expect(
        failed.pendingAnchorCorrectionRow == nil,
        "failed correction should not mark the target row as pending"
    )

    let succeeded = ghosttyScrollCorrectionDispatchState(
        previousLastSentRow: 4,
        previousPendingAnchorCorrectionRow: nil,
        targetRowFromBottom: 15,
        dispatchSucceeded: true
    )

    expect(succeeded.lastSentRow == 15, "successful correction should update the last-sent row")
    expect(
        succeeded.pendingAnchorCorrectionRow == 15,
        "successful correction should mark the target row as pending"
    )
}

@main
struct GhosttyViewportSyncLogicTestRunner {
    static func main() {
        testPreservesStoredTopVisibleRowWhenNewOutputArrives()
        testInternalScrollCorrectionDoesNotCountAsExplicitViewportChange()
        testFailedScrollCorrectionDispatchDoesNotBlockRetry()
        print("PASS: ghostty viewport sync logic")
    }
}
