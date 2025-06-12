import {
  Component,
  OnInit,
  ElementRef,
  ViewChild,
  AfterViewInit,
  ChangeDetectorRef,
  ChangeDetectionStrategy, signal, WritableSignal, HostListener, ViewChildren, viewChild, viewChildren
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DragDropModule, CdkDragEnd, CdkDragStart, CdkDragMove } from '@angular/cdk/drag-drop';
import { EventBlockComponent } from '../event-block/event-block.component';
import { DateUtilsService } from '../../services/date-utils.service';
import { EventData } from '../../models/event.model';
import { Supplier } from '../../models/supplier.model';
import { Week } from '../../models/week.model';
import {ImportDataComponent} from '../import-data/import-data.component';
import {DataService} from '../../services/data.service';
import {combineLatest, filter, fromEvent, throttleTime} from 'rxjs';
import {MatButtonModule} from '@angular/material/button';
import {addWeeks, getISOWeek, setWeek, setYear, startOfWeek, subWeeks} from 'date-fns';

// Interface for event bounding boxes (useful for overlap calculations)
interface EventRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

@Component({
  selector: 'app-scheduler-grid',
  standalone: true,
  imports: [
    CommonModule,
    DragDropModule,
    EventBlockComponent,
    ImportDataComponent,
    MatButtonModule
  ],
  templateUrl: './scheduler-grid.component.html',
  styleUrls: ['./scheduler-grid.component.scss']
})
export class SchedulerGridComponent implements OnInit, AfterViewInit {
  @ViewChild('gridContainer') gridContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('scrollContainer') scrollContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('supplierContainer') supplierContainer!: ElementRef<HTMLDivElement>;

  WEEK_COLUMN_WIDTH_PX = 30;
  AMOUNT_ROW_HEIGHT_UNIT_PX = 0.02;
  SUPPLIER_COLUMN_WIDTH_PX = 130;

  weeks: Week[] = [];
  suppliers: Supplier[] = [];
  events: WritableSignal<EventData[]> = signal([]);
  years: {year: number; count: number}[] = [];

  // Placeholder properties
  showPlaceholder: boolean = false;
  placeholderLeftPx: number = 0;
  placeholderTopPx: number = 0;
  placeholderWidthPx: number = 0;
  placeholderHeightPx: number = 0;

  // Store the event being dragged for placeholder calculations
  private draggingEvent: EventData | null = null;

  // Define a small vertical offset for stacking
  private STACK_VERTICAL_OFFSET_PX = 0; // 0 pixels between stacked events

  selfUpdate = false;

  constructor(private dateUtils: DateUtilsService, private cdr: ChangeDetectorRef, private dataService: DataService) { }

  ngOnInit(): void {
    combineLatest([
      this.dataService.suppliers$,
      this.dataService.events$
    ]).pipe(filter(() => !this.selfUpdate))
      .subscribe(
      ([suppliers, events]) => {
        this.suppliers = suppliers;
        if ((suppliers.length > 0) && (events.length > 0)) {
          this.generateWeekRange(events);
          this.events.set(events);
          this.calculateAllEventPositions();
        }
        this.cdr.detectChanges();
      });
  }

  ngAfterViewInit(): void {
    this.onScrollContainer();
    this.onScrollSuppliers();
    this.cdr.detectChanges();
  }

  generateWeekRange(events: EventData[]) {
    let startViewWeek = '';
    let endViewWeek = '';
    events.forEach((item: EventData) => {
      if (startViewWeek) {
        const a = this.dateUtils.parseWeekString(startViewWeek);
        const b = this.dateUtils.parseWeekString(item.startWeek);
        if (b < a) {
          startViewWeek = item.startWeek;
        }
      } else {
        startViewWeek = item.startWeek;
      }

      if (endViewWeek) {
        const a = this.dateUtils.parseWeekString(endViewWeek);
        const b = this.dateUtils.parseWeekString(item.endWeek);
        if (b > a) {
          endViewWeek = item.endWeek;
        }
      } else {
        endViewWeek = item.endWeek;
      }
    });
    this.weeks = this.dateUtils.generateWeekRange(startViewWeek, endViewWeek);
    this.getYearsArray();
  }

  addWeeksToRange(start: boolean) {
    if (this.weeks.length > 0) {
      const week = start ? this.weeks[0] : this.weeks[this.weeks.length - 1];
      if (start) {
        this.weeks.unshift(new Week(this.dateUtils.getWeekString(subWeeks(this.dateUtils.parseWeekString(`${week.year}-${week.label}`), 1))));
      } else {
        this.weeks.push(new Week(this.dateUtils.getWeekString(addWeeks(this.dateUtils.parseWeekString(`${week.year}-${week.label}`), 1))));
      }
      this.getYearsArray();

      this.calculateAllEventPositions();
    }
  }

  getYearsArray() {
    const arr: {year: number; count: number}[] = [];
    let currentYear: number = 0;
    let count: number = 0;
    this.weeks.forEach((week, ind) => {
      if (currentYear === week.year) {
        count = count + 1;
      } else {
        if ((currentYear !== 0) && (ind !== this.weeks.length - 1)) {
          arr.push({year: currentYear, count: count});
        }
        currentYear = week.year;
        count = 1;
      }
      if (ind === this.weeks.length - 1) {
        arr.push({year: currentYear, count: count});
      }
    });
    this.years = arr;
  }

  // --- Helper to calculate positions for all events ---
  // Modified to reset stackOffsetPx before calculating base positions and then applying stacking.
  calculateAllEventPositions(): void {
    // First, ensure stackOffsetPx is reset for all events.
    // This is crucial before re-calculating positions, especially after a drag.
    this.events().forEach(event => {
      event.stackOffsetPx = 0; // Reset
      // Now calculate the base left and top positions (which modify the event object)
      this.getEventLeftPosition(event);
      this.getEventTopPosition(event); // This calculates the *base* top.
    });
    // Then, apply stacking across all lanes based on their base positions
    this.applyStackingForAllEvents();
    this.updateSupplierPeakCapacities();
    this.applyStackingForAllEvents();
    this.updateSupplierPeakCapacities();
    this.updateEvents();
  }

  // --- NEW METHOD: Dynamically Update Supplier Peak Capacities ---
  /**
   * Calculates the peak (maximum) event amount usage for each supplier
   * across all weeks in the current view.
   * Updates the `calculatedCapacity` property of each supplier.
   */
  public updateSupplierPeakCapacities(): void {
    // A map to store weekly amounts for each supplier:
    // { supplierId: { '2023-W36': 150, '2023-W37': 270, ... } }
    const supplierWeeklyAmounts = new Map<string, Map<string, number>>();

    // Initialize map for each supplier
    this.suppliers.forEach(supplier => {
      supplierWeeklyAmounts.set(supplier.id, new Map<string, number>());
      supplier.calculatedCapacity = 0; // Reset for recalculation
    });

    // Iterate through all events to accumulate amounts per week per supplier
    this.events().forEach(event => {
      const startWeekDate = this.dateUtils.parseWeekString(event.startWeek);
      const endWeekDate = this.dateUtils.parseWeekString(event.endWeek);

      // Iterate through each week the event spans
      let currentWeekDate = new Date(startWeekDate);
      while (currentWeekDate <= endWeekDate) {
        const weekString = this.dateUtils.getWeekString(currentWeekDate);
        const currentSupplierWeeklyMap = supplierWeeklyAmounts.get(event.supplierId);

        if (currentSupplierWeeklyMap) {
          const currentAmount = currentSupplierWeeklyMap.get(weekString) || 0;
          currentSupplierWeeklyMap.set(weekString, currentAmount + event.amount);
        }

        currentWeekDate = this.dateUtils.addWeeks(currentWeekDate, 1); // Move to the next week
      }
    });

    // Determine the peak usage for each supplier
    this.suppliers.forEach(supplier => {
      const weeklyAmountsMap = supplierWeeklyAmounts.get(supplier.id);
      if (weeklyAmountsMap) {
        let peakAmount = 0;
        weeklyAmountsMap.forEach(amount => {
          if (amount > peakAmount) {
            peakAmount = amount;
          }
        });
        supplier.calculatedCapacity = peakAmount; // Assign the peak usage
      }
    });

    this.cdr.detectChanges(); // Trigger change detection to update the view with new capacities
  }



  // --- NEW: Apply Stacking Logic for all events ---
  // This will be called after initial positions are set, and after a drag operation
  private applyStackingForAllEvents(): void {
    const uniqueSupplierIds = new Set(this.events().map(e => e.supplierId));
    uniqueSupplierIds.forEach(supplierId => {
      this.applyStackingForLane(supplierId, this.events());
    });
    // After applying stacking, trigger change detection
    this.cdr.detectChanges();
  }

  private applyStackingForLane(supplierId: string, eventsArray: EventData[]): void {
    const eventsInLane = eventsArray.filter(e => e.supplierId === supplierId);

    eventsInLane.sort((a, b) => {
      const startWeekA = this.dateUtils.parseWeekString(a.startWeek).getTime();
      const startWeekB = this.dateUtils.parseWeekString(b.startWeek).getTime();
      if (startWeekA !== startWeekB) return startWeekA - startWeekB;

      const baseTopA = this.calculateEventBaseTopPositionInternal(a);
      const baseTopB = this.calculateEventBaseTopPositionInternal(b);
      if (baseTopA !== baseTopB) return baseTopA - baseTopB;

      const durationA = this.dateUtils.getWeekRangeCount(a.startWeek, a.endWeek);
      const durationB = this.dateUtils.getWeekRangeCount(b.startWeek, b.endWeek);
      if (durationA !== durationB) return durationB - durationA;

      return a.id.localeCompare(b.id);
    });

    const placedEventRects: EventRect[] = [];

    for (const currentEvent of eventsInLane) {
      const currentEventCalculatedLeft = this.calculateEventLeftPositionInternal(currentEvent);
      const currentEventWidth = this.getEventBlockWidth(currentEvent);
      const currentEventHeight = this.getEventBlockHeight(currentEvent);

      let maxOverlappingBottom = 0;

      for (const placedRect of placedEventRects) {
        const xOverlap = Math.max(0, Math.min(
          currentEventCalculatedLeft + currentEventWidth,
          placedRect.left + placedRect.width
        ) - Math.max(currentEventCalculatedLeft, placedRect.left));

        if (xOverlap > 0) {
          maxOverlappingBottom = Math.max(maxOverlappingBottom, placedRect.top + placedRect.height);
        }
      }

      // Determine the new stack offset based on the max bottom of overlapping events
      const newStackOffsetPx = maxOverlappingBottom > 0
        ? (maxOverlappingBottom - this.calculateEventBaseTopPositionInternal(currentEvent) + this.STACK_VERTICAL_OFFSET_PX)
        : 0; // If no overlap, stack offset is 0

      // Update the event's stack offset and final top position
      currentEvent.stackOffsetPx = newStackOffsetPx;
      currentEvent.topPosition = this.calculateEventBaseTopPositionInternal(currentEvent) + currentEvent.stackOffsetPx;
      currentEvent.leftPosition = currentEventCalculatedLeft;

      placedEventRects.push({
        id: currentEvent.id,
        left: currentEvent.leftPosition,
        top: currentEvent.topPosition,
        width: currentEventWidth,
        height: currentEventHeight
      });
    }
  }


  // --- Drag Event Handlers ---

  onDragStarted(event: CdkDragStart, eventData: EventData): void {
    this.draggingEvent = eventData;
    this.showPlaceholder = true; // Show placeholder when drag starts

    // Set initial placeholder dimensions (same as the event block)
    this.placeholderWidthPx = this.getEventBlockWidth(eventData);
    this.placeholderHeightPx = this.getEventBlockHeight(eventData);

    // Set the initial placeholder position to the event's current logical position
    // Use the values already stored in eventData
    this.placeholderLeftPx = eventData.leftPosition;
    this.placeholderTopPx = eventData.topPosition;

    this.cdr.detectChanges(); // Force update to show placeholder immediately
  }

  onDragMoved(event: CdkDragMove, eventData: EventData): void {
    if (!this.draggingEvent) return; // Should not happen, but for safety

    const draggedDistanceX = event.distance.x;
    const draggedDistanceY = event.distance.y;

    // Get the element's original *base* logical position (before drag started or stacking)
    // We use internal calculation methods to get the raw base positions.
    const originalLeftPx = this.calculateEventLeftPositionInternal(eventData);
    const originalTopPx = this.calculateEventBaseTopPositionInternal(eventData);

    // Calculate the potential new logical X and Y positions
    const potentialNewLogicalX = originalLeftPx + draggedDistanceX;
    const potentialNewLogicalY = originalTopPx + draggedDistanceY;

    // --- Calculate potential New Start Week for Placeholder ---
    const potentialNewStartWeekIndex = Math.round(potentialNewLogicalX / this.WEEK_COLUMN_WIDTH_PX);
    let effectiveStartWeekIndex = potentialNewStartWeekIndex;

    // Clamp the potential index to valid week range for the placeholder
    if (effectiveStartWeekIndex < 0) effectiveStartWeekIndex = 0;
    if (effectiveStartWeekIndex >= this.weeks.length) effectiveStartWeekIndex = this.weeks.length - 1;


    // --- Calculate potential New Supplier for Placeholder ---
    let potentialNewSupplierId: string | undefined = undefined;
    let currentSupplierLaneY = 0;
    for (const supplier of this.suppliers) {
      const supplierRowHeight = this.getSupplierCapacity(supplier) * this.AMOUNT_ROW_HEIGHT_UNIT_PX;
      if (potentialNewLogicalY >= currentSupplierLaneY && potentialNewLogicalY < currentSupplierLaneY + supplierRowHeight) {
        potentialNewSupplierId = supplier.id;
        break;
      }
      currentSupplierLaneY += supplierRowHeight;
    }

    // Now, update placeholder position based on snapped positions
    this.placeholderLeftPx = effectiveStartWeekIndex * this.WEEK_COLUMN_WIDTH_PX;

    // Fallback to the first supplier if the drop position is outside known supplier lanes
    let effectiveSupplierIndex = this.suppliers.findIndex(s => s.id === potentialNewSupplierId);
    if (effectiveSupplierIndex === -1) effectiveSupplierIndex = 0;

    let placeholderSupplierTop = 0;
    for (let i = 0; i < effectiveSupplierIndex; i++) {
      placeholderSupplierTop += this.getSupplierCapacity(this.suppliers[i]) * this.AMOUNT_ROW_HEIGHT_UNIT_PX;
    }
    this.placeholderTopPx = placeholderSupplierTop;

    this.cdr.detectChanges(); // Force change detection to update placeholder position quickly during drag
  }

  onDragEnded(event: CdkDragEnd, eventData: EventData): void {
    // Hide placeholder and clear dragging event reference
    this.showPlaceholder = false;
    this.draggingEvent = null;

    // Get the element's initial *base* logical position (before drag started, ignoring current stack offset)
    const initialLeftPx = this.calculateEventLeftPositionInternal(eventData);
    const initialTopPx = (eventData.topPosition - this.calculateEventBaseTopPositionInternal(eventData)) + this.calculateEventBaseTopPositionInternal(eventData);

    // Get the distance dragged from the cdkDragEnd event
    const draggedDistanceX = event.distance.x;
    const draggedDistanceY = event.distance.y;

    // Calculate the new logical X and Y positions for the final placement
    const newLogicalX = initialLeftPx + draggedDistanceX;
    const newLogicalY = initialTopPx + draggedDistanceY;

    // --- Determine new startWeek based on newLogicalX ---
    const newStartWeekIndex = Math.round(newLogicalX / this.WEEK_COLUMN_WIDTH_PX);
    let newStartWeekString: string; // Changed to string, no undefined for safety
    if (newStartWeekIndex >= 0 && newStartWeekIndex < this.weeks.length) {
      const newStartWeekObj = this.weeks[newStartWeekIndex];
      newStartWeekString = this.dateUtils.getWeekString(this.dateUtils.parseWeekString(`${newStartWeekObj.year}-W${String(newStartWeekObj.weekNumber).padStart(2, '0')}`));
    } else {
      console.warn(`Dropped outside valid week range. X: ${newLogicalX}, Index: ${newStartWeekIndex}. Reverting to original week.`);
      newStartWeekString = eventData.startWeek;
    }

    const durationWeeks = this.dateUtils.getWeekRangeCount(eventData.startWeek, eventData.endWeek);
    let newEndWeekString: string; // Changed to string
    if (newStartWeekString) {
      const newEndWeekDate = this.dateUtils.addWeeks(this.dateUtils.parseWeekString(newStartWeekString), durationWeeks - 1);
      newEndWeekString = this.dateUtils.getWeekString(newEndWeekDate);
    } else {
      newEndWeekString = eventData.endWeek; // Should not happen if newStartWeekString is always set
    }

    // --- Determine new supplier based on newLogicalY ---
    let newSupplierId: string | undefined = undefined;
    let currentSupplierLaneY = 0;
    for (const supplier of this.suppliers) {
      const supplierRowHeight = this.getSupplierCapacity(supplier) * this.AMOUNT_ROW_HEIGHT_UNIT_PX;
      if (newLogicalY >= currentSupplierLaneY && newLogicalY < currentSupplierLaneY + supplierRowHeight) {
        newSupplierId = supplier.id;
        break;
      }
      currentSupplierLaneY += supplierRowHeight;
    }

    if (!newSupplierId) {
      console.warn(`Dropped outside valid supplier lanes. Y: ${newLogicalY}. Reverting to original supplier.`);
      newSupplierId = eventData.supplierId;
    }

    // --- Update Event Data & Re-render ---
    // Create a new array reference and update the specific event to trigger OnPush
    const updatedEvents = this.events().map(e => {
      if ((e.id === eventData.id) && (e.productType === eventData.productType)) {
        return {
          ...e,
          startWeek: newStartWeekString,
          endWeek: newEndWeekString,
          supplierId: newSupplierId,
          stackOffsetPx: 0 // Reset stack offset for the dragged event for re-calculation
        };
      }
      return e;
    });

    this.events.set(updatedEvents); // Assign new array to trigger change detection

    this.changeLeftPositionToRelatedEvent(eventData);
    this.updateEvents();

    // After updating the event's core properties, re-calculate all positions and apply stacking
    // The previous calls to getEventLeftPosition(e) and getEventTopPosition(e) were insufficient
    // because they didn't account for the new stacking.
    this.calculateAllEventPositions(); // Re-calculate base positions for all events

    console.log(`Event ${eventData.name} final update to: ${newStartWeekString} - ${newEndWeekString}, Supplier: ${newSupplierId}`);

    // IMPORTANT: Clear the transform applied by cdkDrag
    // This needs to be done *after* Angular has applied the new top/left positions
    setTimeout(() => {
      event.source.element.nativeElement.style.transform = '';
      this.cdr.detectChanges(); // Trigger final change detection
    }, 0);
  }

  changeLeftPositionToRelatedEvent(eventData: EventData): void {
    const find = this.events().find(e => (e.id === eventData.id) && (e.productType === eventData.productType));
    if (find) {
      const durationWeeks = (find.productType === 'F') ? 10 : 18;
      const newEndWeekDate = this.dateUtils.addWeeks(this.dateUtils.parseWeekString(find.startWeek), durationWeeks);
      const newEndWeekString = this.dateUtils.getWeekString(newEndWeekDate);

      const updatedEvents = this.events().map(ev => {
        if ((ev.id === eventData.id) && (ev.productType !== eventData.productType)) {
          return {
            ...ev,
            startWeek: find.startWeek,
            endWeek: newEndWeekString,
            stackOffsetPx: 0 // Reset stack offset for the dragged event for re-calculation
          };
        }
        return ev;
      });
      this.events.set(updatedEvents);
    }
  }

  // --- NEW: Stacking Logic Placeholder ---
  // This method will now be properly implemented to handle overlapping events.
  // It's called internally by applyStackingForLane.
  checkForOverlappingEvents() {
    // This function can now be removed or refactored as its logic is within applyStackingForLane.
    // If you had other general overlap checks (e.g., for visual warnings), they'd go here.
    // For now, it's just a placeholder as the core stacking is in applyStackingForLane.
  }

  // --- Helper Methods (Modified to work with stacking logic) ---

  // Original getEventTopPosition and getEventLeftPosition now become setters for EventData
  // and are primarily called by calculateAllEventPositions.
  // The template bindings will directly read event.topPosition and event.leftPosition.

  /**
   * Calculates the base top position for an event (based on supplier lane, no stacking).
   * It also sets the `topPosition` on the event data, but this will be overridden
   * by stacking if there are overlaps.
   * This function is primarily used internally by `calculateAllEventPositions`.
   */
  getEventTopPosition(event: EventData, eventBlockComponent: EventBlockComponent | any = null): void {
    const supplierIndex = this.suppliers.findIndex(s => s.id === event.supplierId);
    if (supplierIndex === -1) {
      console.warn(`Event ${event.id} has no valid supplierId: ${event.supplierId}. Positioning at top.`);
      event.topPosition = 0;
      return;
    }
    let totalHeightAbove = 0;
    for (let i = 0; i < supplierIndex; i++) {
      totalHeightAbove += this.getSupplierCapacity(this.suppliers[i]) * this.AMOUNT_ROW_HEIGHT_UNIT_PX;
    }
    /*const eventSupplierCapacity = this.suppliers.find(s => s.id === event.supplierId)?.capacity;
    if (eventSupplierCapacity) {
      totalHeightAbove += (eventSupplierCapacity - event.amount) * this.AMOUNT_ROW_HEIGHT_UNIT_PX;
    }*/
    // Set the base top position here. StackOffsetPx will be added by applyStackingForLane.
    event.topPosition = totalHeightAbove;

    // This part for clearing transform is a bit tricky with your current setup.
    // Ideally, cdkDrag should handle its own transform, and you manage the [top]/[left] inputs.
    // If you absolutely need this, it should be called in ngAfterViewInit or when a component is initialized/updated.
    // For now, keeping it as is, but be aware it might not always behave as expected with OnPush and direct property updates.
    /*
    if (this.draggingEvent && (this.draggingEvent.id !== event.id) && eventBlockComponent) {
      eventBlockComponent.eventComponent().nativeElement.style.transform = '';
      // No return needed here, as it's a void function setting a property.
    }
    */
  }

  /**
   * Calculates the left position for an event (based on start week).
   * It also sets the `leftPosition` on the event data.
   * This function is primarily used internally by `calculateAllEventPositions`.
   */
  getEventLeftPosition(event: EventData): void {
    const startWeekIndex = this.weeks.findIndex(w => this.dateUtils.getWeekString(this.dateUtils.parseWeekString(`${w.year}-W${String(w.weekNumber).padStart(2, '0')}`)) === event.startWeek);
    if (startWeekIndex !== -1) {
      event.leftPosition = startWeekIndex * this.WEEK_COLUMN_WIDTH_PX;
      return;
    }
    console.warn(`Event ${event.id} startWeek ${event.startWeek} not found in current view. Positioning at left (0).`);
    event.leftPosition = 0;
  }

  // --- NEW: Internal Helpers for calculations (don't modify event object) ---
  // These are pure functions to calculate positions without side effects,
  // used by stacking logic and drag calculations.

  /**
   * Calculates the raw left position of an event based on its start week.
   * Does NOT modify the event object.
   */
  private calculateEventLeftPositionInternal(event: EventData): number {
    const startWeekIndex = this.weeks.findIndex(w => this.dateUtils.getWeekString(this.dateUtils.parseWeekString(`${w.year}-W${String(w.weekNumber).padStart(2, '0')}`)) === event.startWeek);
    if (startWeekIndex !== -1) {
      return startWeekIndex * this.WEEK_COLUMN_WIDTH_PX;
    }
    return 0; // Default to 0 if not found
  }

  /**
   * Calculates the base top position of an event based purely on its supplier lane.
   * This does NOT include any stacking offset and does NOT modify the event object.
   */
  private calculateEventBaseTopPositionInternal(event: EventData): number {
    const supplierIndex = this.suppliers.findIndex(s => s.id === event.supplierId);
    if (supplierIndex === -1) {
      return 0; // Default to 0 if no valid supplier
    }
    let totalHeightAboveSuppliers = 0;
    for (let i = 0; i < supplierIndex; i++) {
      totalHeightAboveSuppliers += this.getSupplierCapacity(this.suppliers[i]) * this.AMOUNT_ROW_HEIGHT_UNIT_PX;
    }
   /* const eventSupplierCapacity = this.suppliers.find(s => s.id === event.supplierId)?.capacity;
    if (eventSupplierCapacity) {
      totalHeightAboveSuppliers += (eventSupplierCapacity - event.amount) * this.AMOUNT_ROW_HEIGHT_UNIT_PX;
    }*/
    return totalHeightAboveSuppliers;
  }

  onEditEvent(eventData: EventData): void {
    const updated = this.events().map((ev: EventData) => {
      if (ev.id === eventData.id) {
        ev.name = eventData.name;
        ev.amount = eventData.amount;
        ev.maxShiftWeeksEarly = eventData.maxShiftWeeksEarly;
        ev.maxShiftWeeksLate = eventData.maxShiftWeeksLate;
      }
      return ev;
    });
    this.events.set(updated);
    this.calculateAllEventPositions();
    this.updateEvents();
  }


  // --- Helper Methods (Dimensions, Background Lines, TrackBy) ---

  getSupplierCapacity(s: Supplier): number {
    return (s.calculatedCapacity && (s.calculatedCapacity > s.capacity)) ? s.calculatedCapacity : s.capacity;
  }

  getGridContentHeight(): number {
    const totalCapacity = this.suppliers.reduce((sum, s) => sum + this.getSupplierCapacity(s), 0);
    return totalCapacity * this.AMOUNT_ROW_HEIGHT_UNIT_PX;
  }

  getSupplierLineTopPosition(index: number): number {
    const sumOfPreviousCapacities = this.suppliers
      .slice(0, index)
      .reduce((sum, s) => sum + this.getSupplierCapacity(s), 0);
    return sumOfPreviousCapacities * this.AMOUNT_ROW_HEIGHT_UNIT_PX;
  }

  getEventBlockWidth(event: EventData): number {
    return this.dateUtils.getWeekRangeCount(event.startWeek, event.endWeek) * this.WEEK_COLUMN_WIDTH_PX;
  }

  getEventBlockHeight(event: EventData): number {
    return event.amount * this.AMOUNT_ROW_HEIGHT_UNIT_PX;
  }

  trackByEventId(index: number, event: EventData): string {
    return event.id;
  }

  updateEvents() {
    this.selfUpdate = true;
    this.dataService.events$.next(this.events());
    this.dataService.suppliers$.next(this.suppliers);
    this.selfUpdate = false;
  }

  onScrollContainer() {
    if (!this.scrollContainer) {
      setTimeout(() => {
        this.onScrollContainer();
      }, 100);
      return;
    }

    fromEvent(this.scrollContainer.nativeElement, 'scroll')
      .pipe(throttleTime(0)) // optional: reduce event frequency
      .subscribe(() => {
        this.supplierContainer.nativeElement.scrollTop = this.scrollContainer.nativeElement.scrollTop;
      });
  }

  onScrollSuppliers() {
    if (!this.supplierContainer) {
      setTimeout(() => {
        this.onScrollSuppliers();
      }, 100);
      return;
    }
    debugger

    fromEvent(this.supplierContainer.nativeElement, 'scroll')
      .pipe(throttleTime(0)) // optional: reduce event frequency
      .subscribe(() => {
        this.scrollContainer.nativeElement.scrollTop = this.supplierContainer.nativeElement.scrollTop;
      });
  }
}
