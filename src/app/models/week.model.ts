export class Week {
  year: number;
  weekNumber: number;
  label: string;

  constructor(date: string) {
    const match = date.match(/^(\d{4})-W(\d{2})$/);
    if (!match) {
      this.year = 0;
      this.weekNumber = 0;
      this.label = '';
    } else {
      this.year = parseInt(match[1], 10);
      this.weekNumber = parseInt(match[2], 10);
      this.label = `W${match[2]}`;
    }


  }
}
