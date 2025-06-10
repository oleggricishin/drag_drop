import {Component, DestroyRef, inject, signal, WritableSignal} from '@angular/core';
import {EventData} from '../../../models/event.model';
import {MatDialogActions, MatDialogContent, MatDialogRef, MatDialogTitle} from '@angular/material/dialog';
import {
  AbstractControl,
  FormBuilder,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  ValidationErrors,
  ValidatorFn,
  Validators
} from '@angular/forms';
import {noSpacesValidator} from '../add-supplier/add-supplier.component';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatInputModule} from '@angular/material/input';
import {MatButtonModule} from '@angular/material/button';
import {DataService} from '../../../services/data.service';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Supplier} from '../../../models/supplier.model';
import {MatSelectModule} from '@angular/material/select';
import {addWeeks, getISOWeek, setWeek, setYear, startOfWeek} from 'date-fns';

export function validWeekFormatValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;

    if (typeof value !== 'string') return { invalidFormat: true };

    const match = value.match(/^(\d{4})-W(\d{2})$/);
    if (!match) return { invalidFormat: true };

    const week = parseInt(match[2], 10);
    if (week < 0 || week > 52) return { invalidWeekRange: true };

    return null; // valid
  };
}

@Component({
  selector: 'app-add-event',
  imports: [
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogTitle,
    MatDialogContent,
    MatDialogActions,
    MatSelectModule
  ],
  templateUrl: './add-event.component.html',
  styleUrls: ['./add-event.component.scss']
})
export class AddEventComponent {
  readonly dialogRef = inject(MatDialogRef<AddEventComponent>);

  formEvent: FormGroup;
  suppliers: WritableSignal<Supplier[]> = signal([]);

  constructor(private fb: FormBuilder, public dataService: DataService, private destroyRef: DestroyRef) {
    this.formEvent = this.fb.group({
      id: ['', [Validators.required, noSpacesValidator()]],
      name: ['', Validators.required],
      amount: [null, [Validators.required, Validators.min(1)]],
      maxShiftWeeksEarly: [0, [Validators.required, Validators.min(0)]],
      maxShiftWeeksLate: [0, [Validators.required, Validators.min(0)]],
      date: [null, [Validators.required, validWeekFormatValidator()]],
      supplierId: ['', Validators.required],
    });

    this.dataService.suppliers$.
      pipe(takeUntilDestroyed(this.destroyRef)).
      subscribe(suppliers => {
        this.suppliers.set(suppliers);
    });
  }

  onCloseDialog(close = true): void {
    let events: EventData[] | null = null;
    if (!close) {
      this.formEvent.markAsTouched();
      if (this.formEvent.invalid) return;
      const data = this.formEvent.value;
      data.id = `${data.id}_${data.date}`;
      const eventFemale = new EventData(data);
      const eventMale = Object.assign({}, eventFemale);

      eventFemale.endWeek =  this.getISOWeekString(addWeeks(this.getDateFromISOWeekStr(eventFemale.startWeek), 18));
      eventMale.endWeek =  this.getISOWeekString(addWeeks(this.getDateFromISOWeekStr(eventMale.startWeek), 10));
      eventMale.productType = 'M';

      events = [eventFemale, eventMale];
    }
    this.dialogRef.close(events ? events : null);
  }

  getDateFromISOWeekStr(weekStr: string): Date {
    const [year, week] = weekStr.split('-W').map(Number);
    return this.getDateFromISOWeek(week, year);
  }

  getDateFromISOWeek(week: number, year: number): Date {
    const date = setWeek(setYear(new Date(), year), week);
    return startOfWeek(date, { weekStartsOn: 1 }); // Monday
  }

  getISOWeekString(date: Date): string {
    const week = getISOWeek(date);
    const year = date.getFullYear();
    return `${year}-W${week.toString().padStart(2, '0')}`;
  }
}
